import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  createRuntimeEvent,
  createToolLoopDetector,
  deriveOutcomeFromCause,
  type RuntimeDriver,
  type RuntimeDriverResult,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function toolEvent(args: string, delta = 'same') {
  return createRuntimeEvent({
    kind: 'tool-invocation',
    instanceId: 'runtime-1',
    toolName: 'shell',
    toolKind: 'shell',
    detail: `shell ${args}`,
    argumentsDigest: args,
    observedDeltaDigest: delta,
  });
}

describe('OC-1A tool-loop detector', () => {
  it('warns at four repeated fingerprints and vetoes at six', () => {
    const detector = createToolLoopDetector();
    const decisions = Array.from({ length: 6 }, () => detector.observe(toolEvent('same')));
    expect(decisions[0]?.status).toBe('ok');
    expect(decisions[3]).toMatchObject({ status: 'warn', count: 4 });
    expect(decisions[5]).toMatchObject({ status: 'veto', count: 6 });
  });

  it('does not count changed argument digests as a same-call loop', () => {
    const detector = createToolLoopDetector();
    const decisions = Array.from({ length: 8 }, (_, index) =>
      detector.observe(toolEvent(`arg-${index}`)),
    );
    expect(decisions.every((decision) => decision.status === 'ok')).toBe(true);
  });

  it('detects A/B/A/B ping-pong independently of same-fingerprint count', () => {
    const detector = createToolLoopDetector();
    const args = ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B'];
    const decisions = args.map((arg) => detector.observe(toolEvent(arg)));
    expect(decisions[5]).toMatchObject({ status: 'warn', count: 6 });
    expect(decisions[9]).toMatchObject({ status: 'veto', count: 10 });
  });

  it('treats known polling tools with changing observed delta as progress', () => {
    const detector = createToolLoopDetector();
    const decisions = Array.from({ length: 8 }, (_, index) =>
      detector.observe(
        createRuntimeEvent({
          kind: 'tool-invocation',
          instanceId: 'runtime-1',
          toolName: 'status',
          toolKind: 'polling',
          detail: 'status job-1',
          argumentsDigest: 'job-1',
          observedDeltaDigest: `state-${index}`,
          knownPollingTool: true,
        }),
      ),
    );
    expect(decisions.every((decision) => decision.status === 'ok')).toBe(true);
  });

  it('Plana converts a detector veto into runtime-veto terminal evidence', async () => {
    const taskId = 'task-tool-loop-veto';
    const driver: RuntimeDriver = {
      async run(context): Promise<RuntimeDriverResult> {
        for (let i = 0; i < 6; i += 1) {
          await context.emit({
            kind: 'tool-invocation',
            toolName: 'shell',
            toolKind: 'shell',
            detail: 'echo loop',
            argumentsDigest: 'echo-loop',
            observedDeltaDigest: 'no-change',
          });
        }
        return {
          reason: 'driver finished after loop detector',
          provenance: 'test-driver',
          cause: {
            kind: 'success',
            taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'test-driver',
          },
        };
      },
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest(taskId));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
    expect(evidence.cause.kind).toBe('runtime-veto');
    expect(evidence.provenance).toBe('plana-tool-loop-detector');
    expect(evidence.runtimeWarnings?.map((warning) => warning.status)).toContain('warn');
    expect(evidence.runtimeWarnings?.map((warning) => warning.status)).toContain('veto');
  });
});
