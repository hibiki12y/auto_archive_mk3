/**
 * Entry-script-mode tests for `SlurmApptainerComputeNode` (Phase 3 of the
 * "all tasks must run on slurm+apptainer" rewire).
 *
 * The legacy /bin/sh -c plan.instruction shape is exercised by the
 * existing conformance suite under tests/core/compute-node-slurm-apptainer.spec.ts.
 * This file covers the new entry-script branch only — when the production
 * bootstrap wires `entryScriptPath`, the dispatch plumbs the plan via
 * stdin, parses TerminalEvidence from stdout, and forwards lifecycle
 * NDJSON observations from stderr to the inline observer.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SlurmApptainerComputeNode,
  type SubprocessRequest,
  type SubprocessResult,
  type SubprocessRunner,
} from '../src/core/compute-node-slurm-apptainer.js';
import { Plana } from '../src/core/plana.js';
import { createDispatchPlan } from '../src/core/task.js';
import type { LifecyclePhaseObservation } from '../src/contracts/dispatch-lifecycle.js';
import type { TerminalEvidence } from '../src/contracts/terminal-evidence.js';
import type { RuntimeCancellationBoundary } from '../src/contracts/runtime-driver.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

interface RecordingRunner extends SubprocessRunner {
  readonly calls: SubprocessRequest[];
}

function noopBoundary(): RuntimeCancellationBoundary {
  return {
    cancel: () => ({
      taskId: 'noop',
      reason: 'noop',
      provenance: 'test',
      requestedAt: new Date().toISOString(),
    }),
  };
}

function buildEntryEvidence(taskId: string): TerminalEvidence {
  const now = new Date().toISOString();
  return {
    taskId,
    runtimeInstanceId: `entry-${taskId}`,
    reason: 'entry-script run completed',
    provenance: 'agent-instance-entry',
    executionContext: {
      planCreatedAt: now,
      runtimeSettings: {
        networkProfile: 'provider-only',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        networkProjection: { networkAccessEnabled: false, webSearchMode: 'off' },
      },
    },
    resourceEnvelope: {
      requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
    },
    startedAt: now,
    endedAt: now,
    cause: {
      kind: 'success',
      taskId,
      runtimeInstanceId: `entry-${taskId}`,
      observedAt: now,
      provenance: 'agent-instance-entry',
    },
  } as TerminalEvidence;
}

function recordingRunnerWith(
  responses: ReadonlyArray<SubprocessResult>,
  stderrLineFor?: (req: SubprocessRequest) => string[],
): RecordingRunner {
  const calls: SubprocessRequest[] = [];
  let i = 0;
  const run = vi.fn(async (req: SubprocessRequest) => {
    calls.push(req);
    if (req.command === 'apptainer' && req.onStderrLine && stderrLineFor) {
      for (const line of stderrLineFor(req)) {
        req.onStderrLine(line);
      }
    }
    return responses[i++] ?? { exitCode: 0, stdout: '', stderr: '' };
  });
  return { run, calls } as RecordingRunner;
}

describe('SlurmApptainerComputeNode entry-script mode', () => {
  it('builds an apptainer command that ends with `node <entryScriptPath>` and pipes the plan via stdin', async () => {
    const taskId = 'task-entry-1';
    const evidence = buildEntryEvidence(taskId);
    const runner = recordingRunnerWith([
      { exitCode: 0, stdout: 'salloc: Granted job allocation 9001', stderr: '' },
      { exitCode: 0, stdout: JSON.stringify(evidence) + '\n', stderr: '' },
    ]);
    const node = new SlurmApptainerComputeNode({
      subprocessRunner: runner,
      entryScriptPath: '/opt/auto-archive/dist/runtime/agent-instance-entry.js',
    });

    const plan = createDispatchPlan(createTaskRequest(taskId));
    const allocation = await node.allocate(plan);
    const result = await node.dispatch(allocation, plan, new Plana(), noopBoundary());

    expect(runner.calls).toHaveLength(2);
    const apptainerCall = runner.calls[1]!;
    expect(apptainerCall.command).toBe('apptainer');
    expect(apptainerCall.args).toContain('--cleanenv');
    expect(apptainerCall.args).toContain('node');
    expect(apptainerCall.args).toContain(
      '/opt/auto-archive/dist/runtime/agent-instance-entry.js',
    );
    expect(apptainerCall.args).not.toContain('/bin/sh');
    expect(apptainerCall.args).not.toContain('-c');
    expect(apptainerCall.stdin).toBeDefined();
    const stdinPlan = JSON.parse(apptainerCall.stdin!);
    expect(stdinPlan.taskId).toBe(taskId);
    expect(result.cause.kind).toBe('success');
    expect(result.runtimeInstanceId).toBe(`entry-${taskId}`);
  });

  it('forwards NDJSON lifecycle observations from stderr to the inline observer', async () => {
    const taskId = 'task-entry-2';
    const evidence = buildEntryEvidence(taskId);
    const lines = [
      JSON.stringify({
        phase: 'accepted',
        taskId,
        instanceId: `entry-${taskId}`,
        observedAt: '2026-04-29T12:00:00.000Z',
      }),
      JSON.stringify({
        phase: 'runtime-running',
        taskId,
        instanceId: `entry-${taskId}`,
        observedAt: '2026-04-29T12:00:01.000Z',
      }),
    ];
    const runner = recordingRunnerWith(
      [
        { exitCode: 0, stdout: 'salloc: Granted job allocation 9002', stderr: '' },
        { exitCode: 0, stdout: JSON.stringify(evidence) + '\n', stderr: '' },
      ],
      (req) => (req.command === 'apptainer' ? lines : []),
    );
    const node = new SlurmApptainerComputeNode({
      subprocessRunner: runner,
      entryScriptPath: '/opt/auto-archive/dist/runtime/agent-instance-entry.js',
    });

    const plan = createDispatchPlan(createTaskRequest(taskId));
    const allocation = await node.allocate(plan);
    const observed: LifecyclePhaseObservation[] = [];
    await node.dispatch(allocation, plan, new Plana(), noopBoundary(), (obs) =>
      observed.push(obs),
    );

    const childPhases = observed.map((o) => o.phase);
    // Host emits accepted/runtime-entering/runtime-running before the
    // child reports; child observations are interleaved on top.
    expect(childPhases).toContain('accepted');
    expect(childPhases).toContain('runtime-running');
    expect(childPhases).toContain('terminal');
  });

  it('falls back to driver-failure cause when entry-script stdout is unparseable on success exit', async () => {
    const taskId = 'task-entry-3';
    const runner = recordingRunnerWith([
      { exitCode: 0, stdout: 'salloc: Granted job allocation 9003', stderr: '' },
      { exitCode: 0, stdout: 'this is not JSON\n', stderr: '' },
    ]);
    const node = new SlurmApptainerComputeNode({
      subprocessRunner: runner,
      entryScriptPath: '/opt/auto-archive/dist/runtime/agent-instance-entry.js',
    });

    const plan = createDispatchPlan(createTaskRequest(taskId));
    const allocation = await node.allocate(plan);
    const result = await node.dispatch(allocation, plan, new Plana(), noopBoundary());

    expect(result.cause.kind).toBe('driver-failure');
    expect(result.reason).toContain('evidence unparseable');
  });
});
