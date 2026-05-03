import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import {
  JsonFileTraitSchedulerStore,
  buildTraitSchedulerDryRun,
  discoverTraitModuleManifests,
  evaluateTraitModuleCapabilityBoundary,
  invokeTraitRuntimeHook,
  isTraitModuleMajorSuccessor,
  loadTraitRuntimeDriverDecorator,
  parseTraitModuleManifest,
  traitModuleFamilyId,
  traitModuleMajorVersion,
  traitModuleRegistryKey,
  type TraitModuleLoaderError,
} from '../../src/core/trait-module-loader.js';
import {
  METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
} from '../../src/contracts/methodology-skill.js';
import type { TraitModuleManifest } from '../../src/contracts/trait-module.js';

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'aa-trait-modules-'));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function makeManifest(overrides: Partial<TraitModuleManifest> = {}): TraitModuleManifest {
  return {
    schemaVersion: 1,
    id: 'trait.test.example.v1',
    name: 'example',
    version: '1.0.0',
    trustBoundary: 'repository-owned',
    layout: {
      root: 'traits/example',
      manifest: 'trait.json',
      instruction: 'TRAIT.md',
      runtimeDir: 'runtime',
      schedulesDir: 'schedules',
    },
    instructions: {
      entrypoint: 'TRAIT.md',
      format: 'markdown',
      summary: 'example trait instructions',
    },
    schedule: { mode: 'none' },
    runtime: { hook: 'none' },
    admission: {
      defaultRequested: false,
      requiredCapabilityFlags: [],
      forbiddenCapabilityFlags: [],
      provenance: 'test-provenance',
    },
    sourceMapIds: [],
    ...overrides,
  } as TraitModuleManifest;
}

async function writeTrait(workspace: string, manifest: TraitModuleManifest): Promise<void> {
  const root = resolve(workspace, manifest.layout.root);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, manifest.layout.manifest), JSON.stringify(manifest, null, 2));
  await writeFile(resolve(root, manifest.instructions.entrypoint), '# Trait\n');
}

describe('TraitModule loader / registry', () => {
  it('discovers trait.json files under traits subdirectories and builds deterministic keys', async () => {
    const workspace = makeWorkspace();
    try {
      const manifest = makeManifest();
      await writeTrait(workspace, manifest);

      const registry = discoverTraitModuleManifests({ workspaceRoot: workspace });

      expect(registry.entries).toHaveLength(1);
      expect(registry.entries[0]).toMatchObject({
        manifest: { id: 'trait.test.example.v1', version: '1.0.0' },
        registryKey: 'trait.test.example.v1@1.0.0',
      });
      expect(registry.byRegistryKey.get(traitModuleRegistryKey(manifest))?.manifest.id)
        .toBe('trait.test.example.v1');
    } finally {
      cleanup(workspace);
    }
  });

  it('discovers the repository-owned built-in methodology TraitModule', () => {
    const registry = discoverTraitModuleManifests({ workspaceRoot: process.cwd() });
    const entry = registry.byRegistryKey.get(
      'trait.methodology.agent-methodology-origin.v1@1.0.0',
    );

    expect(entry?.manifest).toEqual(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST);
    expect(entry?.instructionPath.endsWith('traits/methodology-agent-origin/TRAIT.md'))
      .toBe(true);
  });

  it('fails closed for malformed manifest schema and missing TRAIT.md', async () => {
    const workspace = makeWorkspace();
    try {
      const root = join(workspace, 'traits', 'bad');
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'trait.json'), JSON.stringify({ schemaVersion: 1 }));

      expect(() => discoverTraitModuleManifests({ workspaceRoot: workspace })).toThrow(
        /id must be a string/,
      );

      const manifest = makeManifest({
        id: 'trait.test.bad.v1',
        layout: {
          root: 'traits/bad',
          manifest: 'trait.json',
          instruction: 'TRAIT.md',
        },
      });
      await writeFile(join(root, 'trait.json'), JSON.stringify(manifest, null, 2));
      expect(() => discoverTraitModuleManifests({ workspaceRoot: workspace })).toThrow(
        /instruction entrypoint is missing/,
      );
    } finally {
      cleanup(workspace);
    }
  });

  it('rejects duplicate TraitModule id/version pairs but allows distinct major ids', async () => {
    const workspace = makeWorkspace();
    try {
      await writeTrait(workspace, makeManifest());
      await writeTrait(
        workspace,
        makeManifest({
          layout: {
            root: 'traits/example-copy',
            manifest: 'trait.json',
            instruction: 'TRAIT.md',
          },
          instructions: {
            entrypoint: 'TRAIT.md',
            format: 'markdown',
            summary: 'copy',
          },
        }),
      );

      expect(() => discoverTraitModuleManifests({ workspaceRoot: workspace })).toThrow(
        /Duplicate TraitModule manifest id\/version/,
      );

      cleanup(workspace);
      const workspace2 = makeWorkspace();
      try {
        await writeTrait(workspace2, makeManifest());
        await writeTrait(
          workspace2,
          makeManifest({
            id: 'trait.test.example.v2',
            version: '2.0.0',
            layout: {
              root: 'traits/example-v2',
              manifest: 'trait.json',
              instruction: 'TRAIT.md',
            },
            instructions: {
              entrypoint: 'TRAIT.md',
              format: 'markdown',
              summary: 'example v2',
            },
          }),
        );
        const registry = discoverTraitModuleManifests({ workspaceRoot: workspace2 });
        expect(registry.entries.map((entry) => entry.manifest.id)).toEqual([
          'trait.test.example.v1',
          'trait.test.example.v2',
        ]);
      } finally {
        cleanup(workspace2);
      }
    } finally {
      cleanup(workspace);
    }
  });

  it('validates schedule declarations while parsing manifests', () => {
    expect(() =>
      parseTraitModuleManifest(
        makeManifest({
          schedule: {
            mode: 'cron',
            schedules: [
              {
                id: 'daily',
                cron: 'not a cron',
                delivery: 'isolated-session',
                summary: 'bad cron',
              },
            ],
          },
        }),
      ),
    ).toThrow(/cron must have five fields|unsupported cron field/);
  });

  it('rejects manifest fields reserved for kernel-owned authority', () => {
    expect(() =>
      parseTraitModuleManifest({
        ...makeManifest(),
        extensionPoints: ['runtime-provider.select'],
      }),
    ).toThrow(/extensionPoints is reserved for kernel-owned authority/);
    expect(() =>
      parseTraitModuleManifest({
        ...makeManifest(),
        terminalCauseRewrite: true,
      }),
    ).toThrow(/terminalCauseRewrite is reserved for kernel-owned authority/);
  });

  it('rejects reserved kernel-authority keys nested inside layout/instructions/admission/schedule/runtime', () => {
    const baseManifest = makeManifest({
      schedule: {
        mode: 'cron',
        schedules: [
          {
            id: 'daily',
            cron: '0 9 * * *',
            timezone: 'Asia/Tokyo',
            delivery: 'main-session',
            summary: 'daily review',
          },
        ],
      },
      runtime: {
        hook: 'evidence-decorator',
        modulePath: 'traits/example/runtime/decorator.mjs',
        exportName: 'composeTraitRuntimeDriver',
        enforcement: 'required',
        summary: 'evidence decorator',
      },
    });

    const layoutBreach = JSON.parse(JSON.stringify(baseManifest)) as Record<string, unknown>;
    (layoutBreach['layout'] as Record<string, unknown>)['runtimeProvider'] = 'codex';
    expect(() => parseTraitModuleManifest(layoutBreach)).toThrow(
      /runtimeProvider is reserved for kernel-owned authority/,
    );

    const instructionsBreach = JSON.parse(JSON.stringify(baseManifest)) as Record<string, unknown>;
    (instructionsBreach['instructions'] as Record<string, unknown>)['authOverride'] = true;
    expect(() => parseTraitModuleManifest(instructionsBreach)).toThrow(
      /authOverride is reserved for kernel-owned authority/,
    );

    const admissionBreach = JSON.parse(JSON.stringify(baseManifest)) as Record<string, unknown>;
    (admissionBreach['admission'] as Record<string, unknown>)['dispatcherOverride'] = true;
    expect(() => parseTraitModuleManifest(admissionBreach)).toThrow(
      /dispatcherOverride is reserved for kernel-owned authority/,
    );

    const scheduleBreach = JSON.parse(JSON.stringify(baseManifest)) as Record<string, unknown>;
    (scheduleBreach['schedule'] as Record<string, unknown>)['unboundedDaemon'] = true;
    expect(() => parseTraitModuleManifest(scheduleBreach)).toThrow(
      /unboundedDaemon is reserved for kernel-owned authority/,
    );

    const scheduleEntryBreach = JSON.parse(JSON.stringify(baseManifest)) as Record<string, unknown>;
    const schedules = (
      (scheduleEntryBreach['schedule'] as Record<string, unknown>)['schedules'] as Array<
        Record<string, unknown>
      >
    );
    schedules[0]['computeAllocator'] = 'self';
    expect(() => parseTraitModuleManifest(scheduleEntryBreach)).toThrow(
      /computeAllocator is reserved for kernel-owned authority/,
    );

    const runtimeBreach = JSON.parse(JSON.stringify(baseManifest)) as Record<string, unknown>;
    (runtimeBreach['runtime'] as Record<string, unknown>)['providerSwitch'] = true;
    expect(() => parseTraitModuleManifest(runtimeBreach)).toThrow(
      /providerSwitch is reserved for kernel-owned authority/,
    );
  });
});

describe('TraitModule capability boundary', () => {
  it('treats forbiddenCapabilityFlags as module self-request bans, not ambient host bans', () => {
    const approved = evaluateTraitModuleCapabilityBoundary({
      manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
      hostGrantedCapabilityFlags: ['network-access'],
      moduleRequestedCapabilityFlags: [],
    });

    expect(approved.status).toBe('approved');
    expect(approved.ambientForbiddenCapabilityFlagsIgnored).toContain('network-access');

    const rejected = evaluateTraitModuleCapabilityBoundary({
      manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
      hostGrantedCapabilityFlags: [],
      moduleRequestedCapabilityFlags: ['network-access'],
    });

    expect(rejected.status).toBe('rejected');
    expect(rejected.forbiddenSelfRequestedCapabilityFlags).toEqual(['network-access']);
  });

  it('rejects ambient-forbidden capability overlap when ambientForbiddenStrictMode=reject', () => {
    const result = evaluateTraitModuleCapabilityBoundary({
      manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
      hostGrantedCapabilityFlags: ['network-access'],
      moduleRequestedCapabilityFlags: [],
      ambientForbiddenStrictMode: 'reject',
    });

    expect(result.status).toBe('rejected');
    expect(result.ambientForbiddenCapabilityFlagsIgnored).toContain('network-access');
    expect(result.forbiddenSelfRequestedCapabilityFlags).toEqual([]);
    expect(result.missingRequiredCapabilityFlags).toEqual([]);
  });

  it('logs ambient-forbidden capability overlap when ambientForbiddenStrictMode=log without changing status', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = evaluateTraitModuleCapabilityBoundary({
        manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
        hostGrantedCapabilityFlags: ['network-access'],
        moduleRequestedCapabilityFlags: [],
        ambientForbiddenStrictMode: 'log',
      });

      expect(result.status).toBe('approved');
      expect(result.ambientForbiddenCapabilityFlagsIgnored).toContain('network-access');
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]?.[0];
      expect(typeof message).toBe('string');
      expect(message).toContain('trait-module-ambient-forbidden-flags-ignored');
      const jsonStart = (message as string).indexOf('{');
      expect(jsonStart).toBeGreaterThanOrEqual(0);
      const payload = JSON.parse((message as string).slice(jsonStart)) as {
        readonly event: string;
        readonly moduleId: string;
        readonly flags: readonly string[];
      };
      expect(payload.event).toBe('trait-module-ambient-forbidden-flags-ignored');
      expect(payload.moduleId).toBe(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.id);
      expect(payload.flags).toContain('network-access');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not log when strictMode is omitted or set to ignore', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      evaluateTraitModuleCapabilityBoundary({
        manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
        hostGrantedCapabilityFlags: ['network-access'],
        moduleRequestedCapabilityFlags: [],
      });
      evaluateTraitModuleCapabilityBoundary({
        manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
        hostGrantedCapabilityFlags: ['network-access'],
        moduleRequestedCapabilityFlags: [],
        ambientForbiddenStrictMode: 'ignore',
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('TraitModule scheduler dry-run/store', () => {
  it('materializes persistent job records with delivery semantics, retry, and retention', () => {
    const manifest = makeManifest({
      schedule: {
        mode: 'cron',
        schedules: [
          {
            id: 'daily-main',
            cron: '0 9 * * *',
            timezone: 'Asia/Tokyo',
            delivery: 'main-session',
            summary: 'daily main review',
          },
          {
            id: 'hourly-isolated',
            cron: '0 * * * *',
            delivery: 'isolated-session',
            summary: 'hourly isolated review',
          },
          {
            id: 'current',
            cron: '*/15 * * * *',
            delivery: 'current-session',
            summary: 'current session reminder',
          },
        ],
      },
    });

    const dryRun = buildTraitSchedulerDryRun({
      manifests: [manifest],
      now: '2026-04-30T00:00:00.000Z',
      mainSessionId: 'main-session-1',
      currentSessionId: 'current-session-1',
      maxRetries: 5,
      retentionDays: 14,
    });

    expect(dryRun.jobs).toHaveLength(3);
    expect(dryRun.jobs[0]).toMatchObject({
      jobId: 'trait.test.example.v1:1.0.0:daily-main',
      deliveryTarget: { kind: 'main-session', sessionId: 'main-session-1' },
      maxRetries: 5,
      retentionDays: 14,
    });
    expect(dryRun.jobs[1]?.deliveryTarget).toMatchObject({
      kind: 'isolated-session',
      sessionKey: 'trait-schedule:trait.test.example.v1:hourly-isolated',
    });
    expect(dryRun.jobs[2]?.deliveryTarget).toMatchObject({
      kind: 'current-session',
      sessionId: 'current-session-1',
    });
  });

  it('persists scheduler state through the JSON file store', () => {
    const workspace = makeWorkspace();
    try {
      const store = new JsonFileTraitSchedulerStore(join(workspace, 'state', 'traits.json'));
      const state = buildTraitSchedulerDryRun({
        manifests: [],
        now: '2026-04-30T00:00:00.000Z',
      });
      store.save(state);

      expect(JSON.parse(readFileSync(join(workspace, 'state', 'traits.json'), 'utf8')))
        .toMatchObject({ schemaVersion: 1, jobs: [] });
      expect(store.load()).toEqual(state);
    } finally {
      cleanup(workspace);
    }
  });
});

describe('TraitModule version helpers', () => {
  it('separates TraitModuleId major version from manifest package version', () => {
    expect(traitModuleFamilyId('trait.methodology.agent-methodology-origin.v1')).toBe(
      'trait.methodology.agent-methodology-origin',
    );
    expect(traitModuleMajorVersion('trait.methodology.agent-methodology-origin.v1')).toBe(1);
    expect(
      isTraitModuleMajorSuccessor(
        'trait.methodology.agent-methodology-origin.v1',
        'trait.methodology.agent-methodology-origin.v2',
      ),
    ).toBe(true);
    expect(
      isTraitModuleMajorSuccessor(
        'trait.methodology.agent-methodology-origin.v1',
        'trait.other.agent-methodology-origin.v2',
      ),
    ).toBe(false);
  });
});

describe('TraitModule runtime hook loader boundary', () => {
  it('loads an evidence-decorator by generic export without executing the delegate', async () => {
    const workspace = makeWorkspace();
    try {
      const decorator = vi.fn((delegate) => delegate);
      const manifest = makeManifest({
        runtime: {
          hook: 'evidence-decorator',
          modulePath: 'traits/example/runtime/decorator.mjs',
          exportName: 'composeTraitRuntimeDriver',
          enforcement: 'required',
          summary: 'test evidence decorator',
        },
      });

      const loaded = await loadTraitRuntimeDriverDecorator(manifest, {
        workspaceRoot: workspace,
        timeoutMs: 1000,
        importModule: async () => ({ composeTraitRuntimeDriver: decorator }),
      });

      expect(loaded).toMatchObject({
        status: 'loaded',
        manifestId: 'trait.test.example.v1',
        hook: 'evidence-decorator',
      });
      expect(loaded.decorator).toBe(decorator);
      expect(decorator).not.toHaveBeenCalled();

      const missingExport = await loadTraitRuntimeDriverDecorator(manifest, {
        workspaceRoot: workspace,
        timeoutMs: 1000,
        importModule: async () => ({}),
      });
      expect(missingExport).toMatchObject({
        status: 'failed',
        errorCode: 'runtime-export-invalid',
      });

      const wrongHook = await loadTraitRuntimeDriverDecorator(
        {
          ...manifest,
          runtime: {
            hook: 'module-entrypoint',
            modulePath: 'traits/example/runtime/hook.mjs',
            exportName: 'runTraitHook',
            enforcement: 'required',
            summary: 'not a decorator',
          },
        },
        { workspaceRoot: workspace, importModule: async () => ({}) },
      );
      expect(wrongHook).toMatchObject({
        status: 'failed',
        errorCode: 'runtime-export-invalid',
      });

      const importFailure = await loadTraitRuntimeDriverDecorator(manifest, {
        workspaceRoot: workspace,
        timeoutMs: 1000,
        importModule: async () => {
          throw new Error('top-level decorator import failed');
        },
      });
      expect(importFailure).toMatchObject({
        status: 'failed',
        errorCode: 'runtime-import-failed',
      });

      const forbidden = await loadTraitRuntimeDriverDecorator(
        METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
        {
          workspaceRoot: process.cwd(),
          moduleRequestedCapabilityFlags: ['network-access'],
          hostGrantedCapabilityFlags: [],
          importModule: async () => ({ composeTraitRuntimeDriver: decorator }),
        },
      );
      expect(forbidden).toMatchObject({
        status: 'failed',
        errorCode: 'runtime-capability-rejected',
      });
    } finally {
      cleanup(workspace);
    }
  });

  it('loads a repository-owned runtime hook by named export and isolates failures', async () => {
    const workspace = makeWorkspace();
    try {
      const runtimePath = join(workspace, 'traits', 'example', 'runtime', 'hook.mjs');
      await mkdir(join(workspace, 'traits', 'example', 'runtime'), { recursive: true });
      await writeFile(
        runtimePath,
        [
          'export async function runTraitHook(context) {',
          '  return { status: "ok", summary: `ran ${context.moduleId}`, evidence: { scheduleId: context.scheduleId } };',
          '}',
        ].join('\n'),
      );
      const manifest = makeManifest({
        runtime: {
          hook: 'module-entrypoint',
          modulePath: 'traits/example/runtime/hook.mjs',
          exportName: 'runTraitHook',
          enforcement: 'required',
          summary: 'test runtime hook',
        },
      });

      const result = await invokeTraitRuntimeHook(
        manifest,
        { scheduleId: 'daily' },
        { workspaceRoot: workspace, timeoutMs: 1000 },
      );

      expect(result).toMatchObject({
        status: 'ok',
        summary: 'ran trait.test.example.v1',
        result: { evidence: { scheduleId: 'daily' } },
      });

      const missingExport = await invokeTraitRuntimeHook(
        {
          ...manifest,
          runtime: {
            hook: 'module-entrypoint',
            modulePath: 'traits/example/runtime/hook.mjs',
            exportName: 'missing',
            enforcement: 'required',
            summary: 'test runtime hook',
          },
        },
        {},
        { workspaceRoot: workspace, timeoutMs: 1000 },
      );
      expect(missingExport).toMatchObject({
        status: 'failed',
        errorCode: 'runtime-export-invalid',
      });
    } finally {
      cleanup(workspace);
    }
  });

  it('does not execute evidence-decorator manifests through the module-entrypoint path', async () => {
    const result = await invokeTraitRuntimeHook(
      METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
      {},
      {
        workspaceRoot: process.cwd(),
        moduleRequestedCapabilityFlags: [],
        hostGrantedCapabilityFlags: [],
        importModule: async () => {
          throw new Error('should not import an evidence-decorator as an entrypoint');
        },
      },
    );

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'runtime-export-invalid',
    });
    expect(result.summary).toContain('not a module-entrypoint');
  });

  it('resolves source .ts runtime declarations to built dist .js modules when available', async () => {
    const workspace = makeWorkspace();
    try {
      await mkdir(join(workspace, 'src', 'runtime'), { recursive: true });
      await mkdir(join(workspace, 'dist', 'src', 'runtime'), { recursive: true });
      await writeFile(join(workspace, 'src', 'runtime', 'hook.ts'), 'export {};');
      await writeFile(
        join(workspace, 'dist', 'src', 'runtime', 'hook.js'),
        'export function runTraitHook() { return { status: "ok", summary: "dist loaded" }; }',
      );
      const manifest = makeManifest({
        runtime: {
          hook: 'module-entrypoint',
          modulePath: 'src/runtime/hook.ts',
          exportName: 'runTraitHook',
          enforcement: 'required',
          summary: 'dist hook',
        },
      });

      const result = await invokeTraitRuntimeHook(
        manifest,
        {},
        { workspaceRoot: workspace, timeoutMs: 1000 },
      );

      expect(result).toMatchObject({ status: 'ok', summary: 'dist loaded' });
    } finally {
      cleanup(workspace);
    }
  });

  it('fails closed on runtime timeout, trust boundary, path escape, and forbidden self-request', async () => {
    const workspace = makeWorkspace();
    try {
      const manifest = makeManifest({
        runtime: {
          hook: 'module-entrypoint',
          modulePath: '../outside.mjs',
          exportName: 'runTraitHook',
          enforcement: 'required',
          summary: 'bad runtime hook',
        },
      });
      const pathEscape = await invokeTraitRuntimeHook(manifest, {}, { workspaceRoot: workspace });
      expect(pathEscape).toMatchObject({
        status: 'failed',
        errorCode: 'path-outside-workspace',
      });

      const workspaceLocal = await invokeTraitRuntimeHook(
        {
          ...manifest,
          trustBoundary: 'workspace-local',
          runtime: {
            hook: 'module-entrypoint',
            modulePath: 'traits/example/hook.mjs',
            exportName: 'runTraitHook',
            enforcement: 'required',
            summary: 'bad runtime hook',
          },
        },
        {},
        { workspaceRoot: workspace },
      );
      expect(workspaceLocal).toMatchObject({
        status: 'failed',
        errorCode: 'runtime-trust-boundary-rejected',
      });

      const forbidden = await invokeTraitRuntimeHook(
        METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
        {},
        {
          workspaceRoot: process.cwd(),
          moduleRequestedCapabilityFlags: ['network-access'],
          hostGrantedCapabilityFlags: [],
        },
      );
      expect(forbidden).toMatchObject({
        status: 'failed',
        errorCode: 'runtime-capability-rejected',
      });

      const timeout = await invokeTraitRuntimeHook(
        {
          ...makeManifest(),
          runtime: {
            hook: 'module-entrypoint',
            modulePath: 'traits/example/runtime/slow.mjs',
            exportName: 'runTraitHook',
            enforcement: 'required',
            summary: 'slow hook',
          },
        },
        {},
        {
          workspaceRoot: workspace,
          timeoutMs: 5,
          async importModule() {
            return {
              async runTraitHook() {
                await new Promise((resume) => setTimeout(resume, 50));
                return { status: 'ok', summary: 'late' };
              },
            };
          },
        },
      );
      expect(timeout).toMatchObject({
        status: 'failed',
        errorCode: 'runtime-timeout',
      });
    } finally {
      cleanup(workspace);
    }
  });

  it('fails closed with errorCode=runtime-timeout when the hook-path import itself hangs', async () => {
    const workspace = makeWorkspace();
    try {
      const manifest = makeManifest({
        runtime: {
          hook: 'module-entrypoint',
          modulePath: 'traits/example/runtime/hook.mjs',
          exportName: 'runTraitHook',
          enforcement: 'required',
          summary: 'slow import hook',
        },
      });

      const result = await invokeTraitRuntimeHook(
        manifest,
        {},
        {
          workspaceRoot: workspace,
          timeoutMs: 10,
          async importModule() {
            await new Promise((resume) => setTimeout(resume, 100));
            return {
              async runTraitHook() {
                return { status: 'ok', summary: 'late' };
              },
            };
          },
        },
      );

      expect(result).toMatchObject({
        status: 'failed',
        errorCode: 'runtime-timeout',
      });
      expect(result.errorMessage).toContain('hook import timed out');
    } finally {
      cleanup(workspace);
    }
  });
});

describe('TraitModule cron field bounds (Bundle B M2)', () => {
  it.each([
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 7',
    '*/0 * * * *',
    '5-2 * * * *',
    '*/-1 * * * *',
    ', * * * *',
    '5,, * * * *',
  ])('rejects out-of-bounds cron %s', (badCron) => {
    expect(() =>
      parseTraitModuleManifest(
        makeManifest({
          schedule: {
            mode: 'cron',
            schedules: [
              {
                id: 'badcron',
                cron: badCron,
                delivery: 'isolated-session',
                summary: 'invalid cron',
              },
            ],
          },
        }),
      ),
    ).toThrow(/cron .* field/);
  });

  it.each([
    '0 9 * * *',
    '0 * * * *',
    '*/15 * * * *',
    '0,30 9-17 * * 1-5',
    '0 0 1 1 0',
    '0 0 31 12 6',
  ])('accepts valid cron %s', (goodCron) => {
    expect(() =>
      parseTraitModuleManifest(
        makeManifest({
          schedule: {
            mode: 'cron',
            schedules: [
              {
                id: 'goodcron',
                cron: goodCron,
                delivery: 'isolated-session',
                summary: 'valid cron',
              },
            ],
          },
        }),
      ),
    ).not.toThrow();
  });
});
