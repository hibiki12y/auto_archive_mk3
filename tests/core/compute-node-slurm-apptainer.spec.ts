/**
 * Binding tests for `SlurmApptainerComputeNode`
 * (specs/wu-p-slurm-apptainer-integration.md §5 AC-S1..AC-S11).
 *
 * The mock `SlurmAllocator`, `ApptainerRuntime`, `CapabilityResolver`,
 * and `SubprocessRunner` declared at the top of this file are
 * **dependency-injection seams of the production class** (spec §6.2),
 * NOT §6.3-class test doubles — they live alongside the spec rather
 * than under `src/core/__test__/` for that reason.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { deriveOutcomeFromCause } from '../../src/core/derive-outcome.js';

import {
  SlurmApptainerComputeNode,
  compileApptainerInvocation,
  compileCapabilityBoundingSet,
  type ApptainerRuntime,
  type CapabilityResolver,
  type SlurmAllocator,
  type SlurmApptainerComputeNodeOptions,
  type SubprocessRequest,
  type SubprocessResult,
  type SubprocessRunner,
} from '../../src/core/compute-node-slurm-apptainer.js';
import {
  DENIAL_FLOOR,
  UnknownCapabilityError,
  type CapabilityBoundingSet,
  type ComputeCapabilitySurface,
} from '../../src/core/compute-capability.js';
import type { ComputeAllocation } from '../../src/core/compute-node.js';
import { Plana } from '../../src/core/plana.js';
import { createDispatchPlan } from '../../src/core/task.js';
import type { DispatchPlan } from '../../src/core/task.js';
import type {
  LifecycleObserver,
  LifecyclePhaseObservation,
} from '../../src/contracts/dispatch-lifecycle.js';
import type { RuntimeCancellationBoundary } from '../../src/contracts/runtime-driver.js';
import type {
  AdmissionDecision,
  AdmissionTrace,
  DispatchCtx,
} from '../../src/contracts/admission-rule.js';
import type { AdmissionGate } from '../../src/core/admission-gate.js';
import { AdmissionDeniedError } from '../../src/core/admission-denied-error.js';
import type { CapabilityFlag } from '../../src/contracts/capability-flag.js';
import { CAPABILITY_FLAGS } from '../../src/contracts/capability-flag.js';
import { createTaskRequest } from '../helpers/dispatcher-core.js';

// =====================================================================
// DI-seam mock factories (spec §6.2)
// =====================================================================

interface RunnerScript {
  /** Optional ordered queue of programmed responses (FIFO). */
  readonly responses?: ReadonlyArray<SubprocessResult | (() => SubprocessResult | Promise<SubprocessResult>)>;
  /** Default response when the queue is exhausted. */
  readonly fallback?: SubprocessResult;
}

interface MockSubprocessRunner extends SubprocessRunner {
  readonly run: ReturnType<typeof vi.fn>;
  readonly calls: SubprocessRequest[];
}

function createMockSubprocessRunner(script: RunnerScript = {}): MockSubprocessRunner {
  const queue = [...(script.responses ?? [])];
  const fallback: SubprocessResult =
    script.fallback ?? { exitCode: 0, stdout: '', stderr: '' };
  const calls: SubprocessRequest[] = [];
  const run = vi.fn(async (req: SubprocessRequest): Promise<SubprocessResult> => {
    calls.push(req);
    if (queue.length === 0) return fallback;
    const next = queue.shift() as
      | SubprocessResult
      | (() => SubprocessResult | Promise<SubprocessResult>);
    return typeof next === 'function' ? Promise.resolve(next()) : next;
  });
  return { run: run as MockSubprocessRunner['run'], calls };
}

function createMockSlurmAllocator(): SlurmAllocator {
  return { kind: 'slurm-allocator' };
}

function createMockApptainerRuntime(): ApptainerRuntime {
  return { kind: 'apptainer-runtime' };
}

function createMockCapabilityResolver(
  surfaceFn?: (allocationId: string, plan: DispatchPlan) => ComputeCapabilitySurface,
): CapabilityResolver & { surface: ReturnType<typeof vi.fn> } {
  const fallback: ComputeCapabilitySurface = Object.freeze({
    kind: 'slurm-apptainer' as const,
    execution: Object.freeze({
      hasNetwork: false,
      hasFilesystemWrite: false,
      rootless: true,
    }),
    capabilityFlags: Object.freeze([] as CapabilityFlag[]),
  });
  const surface = vi.fn((allocationId: string, plan: DispatchPlan) =>
    surfaceFn ? surfaceFn(allocationId, plan) : fallback,
  );
  return { surface };
}

interface MockAdmissionGate {
  evaluateAndCaptureTrace: ReturnType<typeof vi.fn>;
  requestReevaluation: ReturnType<typeof vi.fn>;
}

function createMockAdmissionGate(opts: {
  decision?: AdmissionDecision;
  reevalCtx?: DispatchCtx;
} = {}): MockAdmissionGate {
  const defaultDecision: AdmissionDecision = {
    verdict: 'admit',
    ruleId: 'mock-rule',
    triggerId: 'T2_ChokepointCrossing',
  };
  const decision = opts.decision ?? defaultDecision;
  const trace: AdmissionTrace = {
    taskId: 'mock',
    trigger: decision.triggerId,
    chokepoint: 'compute-submit',
    attempt: 1,
    ctxHash: 'mock-hash',
    verdict: decision.verdict,
    decidingRuleId: decision.ruleId,
    evaluatedRuleIds: [decision.ruleId],
    timestamp: 0,
  };
  const reevalCtx: DispatchCtx = opts.reevalCtx ?? {
    taskId: 'mock',
    trigger: 'T4_ExplicitReevaluation',
    attempt: 0,
    traits: [],
    metadata: {},
  };
  return {
    evaluateAndCaptureTrace: vi.fn(() => ({ decision, trace })),
    requestReevaluation: vi.fn(() => reevalCtx),
  };
}

function noopCancellationBoundary(): RuntimeCancellationBoundary {
  return {
    cancel: () => ({
      taskId: 'noop',
      reason: 'noop',
      provenance: 'test',
      requestedAt: new Date().toISOString(),
    }),
  };
}

function buildPlan(
  taskId = 'task-slurm-apptainer',
  overrides: Parameters<typeof createTaskRequest>[1] = {},
): DispatchPlan {
  return createDispatchPlan(createTaskRequest(taskId, overrides));
}

interface BuildOpts extends SlurmApptainerComputeNodeOptions {
  /** Skip default DI seams when set. */
  noDefaults?: boolean;
}

function buildNode(overrides: BuildOpts = {}): {
  node: SlurmApptainerComputeNode;
  runner: MockSubprocessRunner;
  resolver: ReturnType<typeof createMockCapabilityResolver>;
} {
  const { noDefaults, ...rest } = overrides;
  const runner =
    (rest.subprocessRunner as MockSubprocessRunner | undefined) ??
    createMockSubprocessRunner({
      responses: [
        { exitCode: 0, stdout: 'salloc: Granted job allocation 4242', stderr: '' },
      ],
    });
  const resolver =
    (rest.capabilityResolver as ReturnType<typeof createMockCapabilityResolver> | undefined) ??
    createMockCapabilityResolver();
  const node = new SlurmApptainerComputeNode({
    allocator: rest.allocator ?? createMockSlurmAllocator(),
    runtime: rest.runtime ?? createMockApptainerRuntime(),
    capabilityResolver: noDefaults ? rest.capabilityResolver : resolver,
    subprocessRunner: noDefaults ? rest.subprocessRunner : runner,
    containerImage: rest.containerImage,
    provenance: rest.provenance,
    admissionGate: rest.admissionGate,
  });
  return { node, runner, resolver };
}

// =====================================================================
// Tests
// =====================================================================

describe('SlurmApptainerComputeNode', () => {
  describe('AC-S1 — allocate returns ComputeAllocation with non-null SLURM job id', () => {
    it('parses SLURM job id from salloc stdout and composes the allocation id', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 0, stdout: 'salloc: Granted job allocation 4242', stderr: '' },
        ],
      });
      const { node } = buildNode({ subprocessRunner: runner });
      const plan = buildPlan('task-alpha');

      const allocation = await node.allocate(plan);

      expect(allocation.allocationId).toBe('slurm-apptainer-task-alpha-4242');
      expect(allocation.capability).toBeDefined();
      expect(allocation.capability.kind).toBe('slurm-apptainer');
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]?.command).toBe('salloc');
      expect(runner.calls[0]?.args).toContain('--job-name=task-alpha');
    });
  });

  describe('AC-S2 — dispatch invokes apptainer with capability-bounded prelude', () => {
    it('emits an apptainer exec call whose args contain the prelude tokens and the plan instruction', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 0, stdout: 'salloc: Granted job allocation 7777', stderr: '' },
          { exitCode: 0, stdout: 'ok', stderr: '' },
        ],
      });
      const { node } = buildNode({ subprocessRunner: runner });
      const plan = buildPlan('task-beta');
      const allocation = await node.allocate(plan);

      await node.dispatch(
        allocation,
        plan,
        new Plana(),
        noopCancellationBoundary(),
      );

      expect(runner.calls).toHaveLength(2);
      const apptainerCall = runner.calls[1];
      expect(apptainerCall.command).toBe('apptainer');
      expect(apptainerCall.args[0]).toBe('exec');
      expect(apptainerCall.args).toContain('--cleanenv');
      expect(apptainerCall.args).toContain('--containall');
      expect(apptainerCall.args).toContain(plan.instruction);

      // Per spec §5 AC-S5 cross-reference (compile-path assertion only;
      // OQ-2 covers the not-yet-spliced flag bundle): no flag in the
      // prelude must violate the DENIAL_FLOOR — i.e. the prelude must
      // not include a `--network=fakeroot` token nor `--nv`.
      expect(apptainerCall.args).not.toContain('--network=fakeroot');
      expect(apptainerCall.args).not.toContain('--nv');
    });

    // -----------------------------------------------------------------
    // OQ-2 resolution: capability-flag splicing into buildApptainerArgs
    // -----------------------------------------------------------------

    it('OQ-2 empty capabilityFlags — splices DENIAL_FLOOR-compiled tokens between prelude and containerImage', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 0, stdout: 'salloc: Granted job allocation 1', stderr: '' },
          { exitCode: 0, stdout: 'ok', stderr: '' },
        ],
      });
      // Default resolver returns empty capabilityFlags → DENIAL_FLOOR.
      const { node } = buildNode({ subprocessRunner: runner });
      const plan = buildPlan('task-empty-capability-flags');
      const allocation = await node.allocate(plan);

      await node.dispatch(
        allocation,
        plan,
        new Plana(),
        noopCancellationBoundary(),
      );

      const apptainerCall = runner.calls[1];
      const args = apptainerCall.args;

      // Prelude head preserved and comes first.
      expect(args.slice(0, 5)).toEqual([
        'exec',
        '--cleanenv',
        '--containall',
        '--no-mount',
        'home',
      ]);

      // DENIAL_FLOOR-compiled flags are spliced before the containerImage.
      const floorFlags = compileApptainerInvocation(DENIAL_FLOOR).flags;
      for (const f of floorFlags) {
        expect(args, `floor flag ${f} must be spliced`).toContain(f);
      }

      // Structural splice: containerImage lives immediately after the
      // last floor-flag token, and is followed by /bin/sh -c <instruction>.
      const imageIdx = args.indexOf('placeholder://slurm-apptainer/runtime');
      expect(imageIdx).toBeGreaterThan(3); // after the prelude head
      expect(args.slice(imageIdx, imageIdx + 4)).toEqual([
        'placeholder://slurm-apptainer/runtime',
        '/bin/sh',
        '-c',
        plan.instruction,
      ]);

      // Forbidden widenings absent under denial floor.
      expect(args).not.toContain('--network=fakeroot');
      expect(args).not.toContain('--nv');
      expect(args).not.toContain('--workdir');
    });

    it('resource-envelope GPU request — emits both salloc --gpus and apptainer --nv without making GPU a CapabilityFlag', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 0, stdout: 'salloc: Granted job allocation 101', stderr: '' },
          { exitCode: 0, stdout: 'ok', stderr: '' },
        ],
      });
      const { node } = buildNode({ subprocessRunner: runner });
      const plan = buildPlan('task-gpu-resource-envelope', {
        resources: {
          requested: {
            cpuCores: 8,
            memoryMiB: 32768,
            wallTimeSec: 3600,
            gpuCards: 1,
          },
        },
      });

      const allocation = await node.allocate(plan);

      expect(runner.calls[0]?.command).toBe('salloc');
      expect(runner.calls[0]?.args).toContain('--gpus=1');
      expect(allocation.capability.capabilityFlags ?? []).toEqual([]);

      await node.dispatch(
        allocation,
        plan,
        new Plana(),
        noopCancellationBoundary(),
      );

      const apptainerCall = runner.calls[1];
      expect(apptainerCall.command).toBe('apptainer');
      expect(apptainerCall.args).toContain('--nv');
      expect(apptainerCall.args).toContain('--network=none');
    });

    it('OQ-2 non-empty capabilityFlags — splices compiled flags (synthetic resolver returning ["network-access","sandbox-mode"])', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 0, stdout: 'salloc: Granted job allocation 2', stderr: '' },
          { exitCode: 0, stdout: 'ok', stderr: '' },
        ],
      });
      const synthetic: ComputeCapabilitySurface = Object.freeze({
        kind: 'slurm-apptainer' as const,
        execution: Object.freeze({
          hasNetwork: true,
          hasFilesystemWrite: true,
          rootless: true,
        }),
        capabilityFlags: Object.freeze(['network-access', 'sandbox-mode'] as CapabilityFlag[]),
      });
      const resolver = createMockCapabilityResolver(() => synthetic);
      const { node } = buildNode({ subprocessRunner: runner, capabilityResolver: resolver });
      const plan = buildPlan('task-nonempty-capability-flags');
      const allocation = await node.allocate(plan);

      await node.dispatch(
        allocation,
        plan,
        new Plana(),
        noopCancellationBoundary(),
      );

      const args = runner.calls[1].args;

      // Expected compiled flags exactly match compileApptainerInvocation
      // applied to the synthetic bounding set.
      const expected = compileApptainerInvocation(
        compileCapabilityBoundingSet(synthetic.capabilityFlags!),
      ).flags;
      for (const f of expected) {
        expect(args, `expected spliced flag ${f}`).toContain(f);
      }

      // sandbox-mode implies scratchWrite → expect --workdir / --no-mount=home
      expect(args).toContain('--workdir');
      expect(args).toContain('--no-mount=home');

      // Still surfaces prelude head + instruction tail.
      expect(args[0]).toBe('exec');
      expect(args).toContain(plan.instruction);
    });

    it('OQ-2 allow-list rejection — resolver returning a non-canonical CapabilityFlag in capabilityFlags causes dispatch to throw UnknownCapabilityError', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 0, stdout: 'salloc: Granted job allocation 3', stderr: '' },
          { exitCode: 0, stdout: 'ok', stderr: '' },
        ],
      });
      // Synthesize a surface that smuggles a non-canonical CapabilityFlag string
      // past the compile-time type system. The dispatch path MUST reject
      // this via the §4.3 allow-list, not silently pass it through.
      const contraband: ComputeCapabilitySurface = {
        kind: 'slurm-apptainer',
        execution: { hasNetwork: false, hasFilesystemWrite: false, rootless: true },
        capabilityFlags: ['not-a-capability-flag' as unknown as CapabilityFlag],
      };
      const resolver = createMockCapabilityResolver(() => contraband);
      const { node } = buildNode({ subprocessRunner: runner, capabilityResolver: resolver });
      const plan = buildPlan('task-bad-capability-flag');
      const allocation = await node.allocate(plan);

      await expect(
        node.dispatch(allocation, plan, new Plana(), noopCancellationBoundary()),
      ).rejects.toBeInstanceOf(UnknownCapabilityError);

      // No apptainer call was made — rejection is strictly pre-dispatch.
      expect(runner.calls.filter((c) => c.command === 'apptainer')).toHaveLength(0);
    });
  });

  describe('AC-S3 — cancel issues scancel exactly once and is idempotent', () => {
    it('calls scancel once on a known allocation, and is a no-op on repeated/unknown calls', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 0, stdout: 'salloc: Granted job allocation 9001', stderr: '' },
        ],
      });
      const { node } = buildNode({ subprocessRunner: runner });
      const plan = buildPlan('task-cancel');
      const allocation = await node.allocate(plan);

      // first cancel: one scancel
      const r1 = await node.cancel(allocation, 'operator');
      expect(r1).toBeUndefined();
      const scancelCalls = runner.calls.filter((c) => c.command === 'scancel');
      expect(scancelCalls).toHaveLength(1);
      expect(scancelCalls[0]?.args).toEqual(['9001']);

      // second cancel: idempotent (no additional scancel)
      await node.cancel(allocation, 'operator-again');
      expect(runner.calls.filter((c) => c.command === 'scancel')).toHaveLength(1);

      // unknown allocation: no-op, no throw
      const unknown: ComputeAllocation = {
        allocationId: 'slurm-apptainer-bogus-0',
        capability: allocation.capability,
      };
      await expect(node.cancel(unknown, 'unknown')).resolves.toBeUndefined();
      expect(runner.calls.filter((c) => c.command === 'scancel')).toHaveLength(1);

      // NOTE: spec §5 AC-S3 caveat (OQ-4): the as-built class has no
      // `cancellationGracePeriodMs` and issues a single immediate
      // scancel. We assert the single-shot cooperative semantics rather
      // than the brief's graceful-then-forced sequence.
    });
  });

  describe('AC-S4 — Observer fan-out emits the WU-N phase sequence', () => {
    it('delivers accepted → runtime-entering → runtime-running → settling → terminal in order', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 0, stdout: 'salloc: Granted job allocation 100', stderr: '' },
          { exitCode: 0, stdout: '', stderr: '' },
        ],
      });
      const { node } = buildNode({ subprocessRunner: runner });
      const plan = buildPlan('task-observe');
      const allocation = await node.allocate(plan);

      const observations: LifecyclePhaseObservation[] = [];
      const inlineObserver: LifecycleObserver = (o) => observations.push(o);

      // Attached observer (via observe()) before dispatch — should also see all phases.
      const attached: LifecyclePhaseObservation[] = [];
      node.observe(allocation, (o) => attached.push(o));

      await node.dispatch(
        allocation,
        plan,
        new Plana(),
        noopCancellationBoundary(),
        inlineObserver,
      );

      expect(observations.map((o) => o.phase)).toEqual([
        'accepted',
        'runtime-entering',
        'runtime-running',
        'settling',
        'terminal',
      ]);
      const last = observations[observations.length - 1];
      expect(((last.cause && deriveOutcomeFromCause(last.cause)) ?? undefined)).toBe('success');
      // Stable instance + task id on every observation.
      for (const o of observations) {
        expect(o.taskId).toBe(plan.taskId);
        expect(o.instanceId).toBe('apptainer-100');
      }
      expect(attached.map((o) => o.phase)).toEqual(observations.map((o) => o.phase));

      // CC-5: post-terminal observe() is a no-op (no further events arrive).
      const late: LifecyclePhaseObservation[] = [];
      node.observe(allocation, (o) => late.push(o));
      expect(late).toHaveLength(0);
    });

    it('F8 parity — observer throws are surfaced as compute-node-slurm-apptainer.observer.advisory-throw warns (visibility upgrade)', async () => {
      // Audit 2026-05-03 follow-up: the inline + attached observer
      // fan-out at this compute node previously silently swallowed
      // observer errors with `// advisory: swallow`. PR #5 already
      // upgraded the dispatcher and current-node compute node; this
      // test pins the same upgrade for the SLURM/apptainer node.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 0, stdout: 'salloc: Granted job allocation 200', stderr: '' },
          { exitCode: 0, stdout: '', stderr: '' },
        ],
      });
      const { node } = buildNode({ subprocessRunner: runner });
      const plan = buildPlan('task-f8-apptainer-visibility');
      const allocation = await node.allocate(plan);

      const explosiveInline: LifecycleObserver = () => {
        throw new Error('inline-observer-explosion');
      };
      node.observe(allocation, () => {
        throw new Error('extra-observer-explosion');
      });

      await node.dispatch(
        allocation,
        plan,
        new Plana(),
        noopCancellationBoundary(),
        explosiveInline,
      );

      const warnCalls = warnSpy.mock.calls.flat();
      const matchedPrimary = warnCalls.find(
        (line) =>
          typeof line === 'string' &&
          line.startsWith('compute-node-slurm-apptainer.observer.advisory-throw ') &&
          line.includes('"observerKind":"primary"'),
      ) as string | undefined;
      const matchedExtra = warnCalls.find(
        (line) =>
          typeof line === 'string' &&
          line.startsWith('compute-node-slurm-apptainer.observer.advisory-throw ') &&
          line.includes('"observerKind":"extra"'),
      ) as string | undefined;

      expect(matchedPrimary).toBeDefined();
      expect(matchedExtra).toBeDefined();
      if (matchedPrimary !== undefined) {
        const payload = JSON.parse(
          matchedPrimary.slice(
            'compute-node-slurm-apptainer.observer.advisory-throw '.length,
          ),
        );
        expect(payload.taskId).toBe(plan.taskId);
        expect(payload.source).toBe('inline');
        expect(payload.error).toContain('inline-observer-explosion');
      }
      if (matchedExtra !== undefined) {
        const payload = JSON.parse(
          matchedExtra.slice(
            'compute-node-slurm-apptainer.observer.advisory-throw '.length,
          ),
        );
        expect(payload.error).toContain('extra-observer-explosion');
      }

      warnSpy.mockRestore();
    });
  });

  describe('AC-S5 — DENIAL_FLOOR is honored at compile time', () => {
    it('compileCapabilityBoundingSet([]) returns DENIAL_FLOOR by reference', () => {
      expect(compileCapabilityBoundingSet([])).toBe(DENIAL_FLOOR);
    });

    it('compileApptainerInvocation(DENIAL_FLOOR).flags contains floor tokens only', () => {
      const inv = compileApptainerInvocation(DENIAL_FLOOR);
      expect(inv.flags).toContain('--containall');
      expect(inv.flags).toContain('--read-only');
      expect(inv.flags).toContain('--network=none');
      expect(inv.flags).not.toContain('--network=fakeroot');
      expect(inv.flags).not.toContain('--nv');
      expect(inv.flags).not.toContain('--workdir');
    });

    it('no CapabilityFlag-powerset bounding set drops --containall', () => {
      const flags = [...CAPABILITY_FLAGS];
      const n = flags.length;
      for (let mask = 0; mask < 1 << n; mask += 1) {
        const subset: CapabilityFlag[] = [];
        for (let i = 0; i < n; i += 1) {
          if (mask & (1 << i)) subset.push(flags[i]);
        }
        const set = compileCapabilityBoundingSet(subset);
        const inv = compileApptainerInvocation(set);
        expect(inv.flags, `subset=${subset.join(',')}`).toContain('--containall');
        // --read-only must remain unless the subset granted scratchWrite
        // (i.e. includes 'sandbox-mode'), per §4.3 table.
        if (!subset.includes('sandbox-mode')) {
          expect(inv.flags, `subset=${subset.join(',')} read-only`).toContain('--read-only');
        }
      }
    });
  });

  describe('AC-S6 — Subprocess failure surfaces faithfully for §6.12 classification', () => {
    it('non-zero apptainer exit → outcome=failure with reason carrying exitCode/stderr', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 0, stdout: 'salloc: Granted job allocation 11', stderr: '' },
          { exitCode: 2, stdout: '', stderr: 'boom' },
        ],
      });
      const { node } = buildNode({ subprocessRunner: runner });
      const plan = buildPlan('task-fail-exit');
      const allocation = await node.allocate(plan);

      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        noopCancellationBoundary(),
      );

      expect(deriveOutcomeFromCause(evidence.cause)).toBe('failure');
      expect(evidence.reason).toContain('apptainer exec failed');
      expect(evidence.reason).toContain('exitCode=2');
      expect(evidence.reason).toContain('boom');
    });

    it('runner throw → outcome=failure with reason containing the thrown message', async () => {
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 0, stdout: 'salloc: Granted job allocation 12', stderr: '' },
          () => {
            throw new Error('connreset');
          },
        ],
      });
      const { node } = buildNode({ subprocessRunner: runner });
      const plan = buildPlan('task-fail-throw');
      const allocation = await node.allocate(plan);

      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        noopCancellationBoundary(),
      );

      expect(deriveOutcomeFromCause(evidence.cause)).toBe('failure');
      expect(evidence.reason).toContain('connreset');
    });
  });

  describe('AC-S7 — Production-only; no test-double cohabitation', () => {
    it('the production source contains no __test__/__tests__/test-helpers/mock- import paths', () => {
      const filePath = resolve(
        __dirname,
        '../../src/core/compute-node-slurm-apptainer.ts',
      );
      const source = readFileSync(filePath, 'utf8');
      // Inspect only import-statement lines so that prose mentions in
      // doc-comments (e.g. "the __test__/ harness") do not trip this.
      const importLines = source
        .split('\n')
        .filter((line) => /^\s*import\s/.test(line) || /^\s*}\s*from\s/.test(line));
      const joined = importLines.join('\n');
      expect(joined).not.toMatch(/__test__/);
      expect(joined).not.toMatch(/__tests__/);
      expect(joined).not.toMatch(/test-helpers/);
      expect(joined).not.toMatch(/['"]mock-/);
    });
  });

  describe('AC-S8 — hasAdapters() is true iff all four adapters are injected', () => {
    const adapterNames = ['allocator', 'runtime', 'capabilityResolver', 'subprocessRunner'] as const;
    type AdapterName = (typeof adapterNames)[number];

    function buildWithMask(mask: number): boolean {
      const opts: SlurmApptainerComputeNodeOptions = {};
      adapterNames.forEach((name, idx) => {
        if (!(mask & (1 << idx))) return;
        const map: Record<AdapterName, unknown> = {
          allocator: createMockSlurmAllocator(),
          runtime: createMockApptainerRuntime(),
          capabilityResolver: createMockCapabilityResolver(),
          subprocessRunner: createMockSubprocessRunner(),
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (opts as any)[name] = map[name];
      });
      return new SlurmApptainerComputeNode(opts).hasAdapters();
    }

    it('returns true only for the all-four-set mask (1 of 16)', () => {
      const trues: number[] = [];
      for (let mask = 0; mask < 16; mask += 1) {
        if (buildWithMask(mask)) trues.push(mask);
      }
      expect(trues).toEqual([0b1111]);
    });

    it('returns false for each one-missing mask (4 cases)', () => {
      for (let i = 0; i < 4; i += 1) {
        const mask = 0b1111 & ~(1 << i);
        expect(buildWithMask(mask)).toBe(false);
      }
    });
  });

  describe('AC-S9 — WU-L T2 admission denial throws AdmissionDeniedError before salloc', () => {
    it('throws AdmissionDeniedError carrying the gate decision/trace, with zero salloc calls', async () => {
      const denyDecision: AdmissionDecision = {
        verdict: 'deny',
        ruleId: 'mock-deny-rule',
        triggerId: 'T2_ChokepointCrossing',
        reason: 'over-quota',
      };
      const gate = createMockAdmissionGate({ decision: denyDecision });
      const runner = createMockSubprocessRunner();
      const { node } = buildNode({
        subprocessRunner: runner,
        admissionGate: gate as unknown as AdmissionGate,
      });
      const plan = buildPlan('task-denied');

      await expect(node.allocate(plan)).rejects.toBeInstanceOf(AdmissionDeniedError);
      expect(runner.calls.filter((c) => c.command === 'salloc')).toHaveLength(0);

      // Re-invoke to inspect the thrown instance fields.
      let caught: unknown;
      try {
        await node.allocate(plan);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AdmissionDeniedError);
      const err = caught as AdmissionDeniedError;
      expect(err.decision).toEqual(denyDecision);
      expect(err.trace.verdict).toBe('deny');

      // The T2 envelope must have been used (chokepoint=compute-submit).
      const firstCall = gate.evaluateAndCaptureTrace.mock.calls[0]?.[0] as DispatchCtx;
      expect(firstCall.trigger).toBe('T2_ChokepointCrossing');
      expect(firstCall.chokepoint).toBe('compute-submit');
    });
  });

  describe('AC-S10 — WU-L T5 resource-exhaustion notification fires only on classified failures', () => {
    it('emits exactly one T5 trace and re-throws when stderr matches QOSMaxJobsPerUserLimit', async () => {
      const gate = createMockAdmissionGate();
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 1, stdout: '', stderr: 'QOSMaxJobsPerUserLimit reached' },
        ],
      });
      const { node } = buildNode({
        subprocessRunner: runner,
        admissionGate: gate as unknown as AdmissionGate,
      });
      const plan = buildPlan('task-t5-classified');

      await expect(node.allocate(plan)).rejects.toThrow(/salloc failed/);

      // First call: T2 envelope. Second call: T5 envelope.
      expect(gate.evaluateAndCaptureTrace).toHaveBeenCalledTimes(2);
      const second = gate.evaluateAndCaptureTrace.mock.calls[1]?.[0] as DispatchCtx;
      expect(second.trigger).toBe('T5_ResourceExhaustion');
      expect(gate.requestReevaluation).toHaveBeenCalledTimes(1);
    });

    it('does not emit a T5 trace when stderr does not match a known exhaustion needle', async () => {
      const gate = createMockAdmissionGate();
      const runner = createMockSubprocessRunner({
        responses: [
          { exitCode: 1, stdout: '', stderr: 'invalid partition' },
        ],
      });
      const { node } = buildNode({
        subprocessRunner: runner,
        admissionGate: gate as unknown as AdmissionGate,
      });
      const plan = buildPlan('task-t5-unrelated');

      await expect(node.allocate(plan)).rejects.toThrow(/salloc failed/);

      // Only the T2 envelope. No T5 trace.
      expect(gate.evaluateAndCaptureTrace).toHaveBeenCalledTimes(1);
      expect(gate.requestReevaluation).not.toHaveBeenCalled();
    });
  });

  describe('AC-S11 — compileApptainerInvocation rejects ill-formed bounding sets', () => {
    it('rejects writeMounts ∩ readOnlyMounts ≠ ∅ with UnknownCapabilityError', () => {
      const set: CapabilityBoundingSet = {
        schemaVersion: 1,
        network: { mode: 'none' },
        filesystem: {
          scratchWrite: false,
          readOnlyMounts: ['/data'],
          writeMounts: ['/data'],
        },
        process: { fork: false, exec: false, ptrace: false },
        devices: { gpu: false, tty: false },
        provenance: [],
      };
      expect(() => compileApptainerInvocation(set)).toThrow(UnknownCapabilityError);
    });

    it('rejects ptrace=true && tty=false with UnknownCapabilityError', () => {
      const set: CapabilityBoundingSet = {
        schemaVersion: 1,
        network: { mode: 'none' },
        filesystem: {
          scratchWrite: false,
          readOnlyMounts: [],
          writeMounts: [],
        },
        process: { fork: false, exec: false, ptrace: true },
        devices: { gpu: false, tty: false },
        provenance: [],
      };
      expect(() => compileApptainerInvocation(set)).toThrow(UnknownCapabilityError);
    });

    it('rejects unknown capability flag strings via compileCapabilityBoundingSet, before any merging', () => {
      expect(() =>
        compileCapabilityBoundingSet(['network-access', 'not-a-capability-flag'] as string[]),
      ).toThrow(UnknownCapabilityError);
    });
  });
});
