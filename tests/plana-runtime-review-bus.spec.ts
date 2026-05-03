import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  createDispatchPlan,
  createRuntimeEvent,
  createRuntimeEventStream,
  vetoRuntime,
  type RuntimeCancellationBoundary,
  type RuntimeDriver,
  type RuntimeEvent,
  type RuntimeEventStream,
  type RuntimeStreamContext,
  type RuntimeTerminalCause,
} from '../src/index.js';
import {
  DuplicateApprovalResponseError,
  LateApprovalResponseError,
  UnknownApprovalRequestIdError,
} from '../src/runtime/agent-runtime.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function createBoundary(taskId: string): RuntimeCancellationBoundary {
  let terminalCause: RuntimeTerminalCause | undefined;
  let waiter: ((cause: RuntimeTerminalCause) => void) | undefined;

  const notify = (cause: RuntimeTerminalCause): void => {
    if (!terminalCause) {
      terminalCause = cause;
      waiter?.(cause);
    }
  };

  return {
    cancel(veto) {
      const receipt = {
        taskId,
        reason: veto.reason,
        provenance: 'test-boundary',
        requestedAt: new Date().toISOString(),
      };
      notify({
        kind: 'runtime-veto',
        taskId,
        reason: veto.reason,
        provenance: veto.provenance,
        requestedAt: receipt.requestedAt,
        veto,
        cancellation: receipt,
      });
      return receipt;
    },
    latchRuntimeVeto(veto) {
      notify({
        kind: 'runtime-veto',
        taskId,
        reason: veto.reason,
        provenance: veto.provenance,
        requestedAt: new Date().toISOString(),
        veto,
      });
      return terminalCause!;
    },
    currentTerminalCause: () => terminalCause,
    whenTerminalCause: async () =>
      terminalCause ??
      (await new Promise<RuntimeTerminalCause>((resolve) => {
        waiter = resolve;
      })),
  };
}

describe('R4b runtime review bus migration', () => {
  it('AC-R4b.1..6: new runtime event kinds round-trip in order via stream consumer', async () => {
    const stream = createRuntimeEventStream();
    const observed: RuntimeEvent[] = [];
    const plana = new Plana({
      runtime: ({ event }) => {
        observed.push(event);
        return undefined;
      },
    });
    const plan = createDispatchPlan(createTaskRequest('task-r4b-roundtrip'));
    const boundary = createBoundary(plan.taskId);
    const consumer = plana.consumeRuntimeStream(stream, {
      plan,
      instance: {
        taskId: plan.taskId,
        instanceId: 'agent-r4b-roundtrip',
        createdAt: new Date().toISOString(),
        runtimeSettings: plan.runtimeSettings,
      },
      cancellationBoundary: boundary,
      approvalResponsePort: {
        async respond() {},
      },
    });

    const base = {
      timestamp: '2026-04-22T00:00:00.000Z',
      instanceId: 'agent-r4b-roundtrip',
      turnSequence: 1,
      provenance: {
        producer: 'codex-runtime-driver' as const,
        sdkEventType: 'turn.started' as const,
        threadId: 'thread-r4b',
      },
    };

    await stream.push(
      createRuntimeEvent({
        ...base,
        kind: 'turn.started',
      }),
    );
    await stream.push(
      createRuntimeEvent({
        ...base,
        kind: 'turn.completed',
        provenance: { ...base.provenance, sdkEventType: 'turn.completed' },
        usage: {
          inputTokens: 10,
          cachedInputTokens: 1,
          outputTokens: 4,
        },
      }),
    );
    await stream.push(
      createRuntimeEvent({
        ...base,
        kind: 'item.completed',
        provenance: { ...base.provenance, sdkEventType: 'item.completed' },
        item: {
          id: 'item-1',
          type: 'command_execution',
          status: 'completed',
          summary: 'completed | echo ok | exit 0',
        },
      }),
    );
    await stream.push(
      createRuntimeEvent({
        ...base,
        kind: 'item.failed',
        provenance: { ...base.provenance, sdkEventType: 'item.failed' },
        item: {
          id: 'item-2',
          type: 'command_execution',
          status: 'failed',
          summary: 'failed | rm -rf /',
        },
        failure: {
          message: 'permission denied',
          code: 'EACCES',
        },
      }),
    );
    await stream.push(
      createRuntimeEvent({
        ...base,
        kind: 'approval.requested',
        provenance: {
          ...base.provenance,
          sdkEventType: 'approval.requested',
        },
        approvalRequestId: 'approval-1',
        deadline: '2026-04-22T00:00:30.000Z',
        request: {
          kind: 'command_execution',
          reason: 'needs approval',
          command: 'rm -rf /',
        },
      }),
    );
    stream.close();
    await consumer;

    expect(observed.map((event) => event.kind)).toEqual([
      'turn.started',
      'turn.completed',
      'item.completed',
      'item.failed',
      'approval.requested',
    ]);
    expect(observed[1]).toMatchObject({
      kind: 'turn.completed',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 4,
      },
    });
  });

  it('AC-R4b.7/11/14: plana veto reaches cancellation boundary and blocks next side effect', async () => {
    let sideEffectCalled = false;
    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        await context.emit({
          kind: 'tool-invocation',
          toolName: 'danger',
          detail: 'should veto',
        });
        if (context.isAborted()) {
          return {
            reason: 'aborted after veto',
            provenance: 'test-driver',
            cause: {
              kind: 'success',
              taskId: context.plan.taskId,
              runtimeInstanceId: context.instance.instanceId,
              observedAt: new Date().toISOString(),
              provenance: 'test-driver',
            },
          };
        }
        sideEffectCalled = true;
        return {
          reason: 'unexpected side effect',
          provenance: 'test-driver',
          cause: {
            kind: 'success',
            taskId: context.plan.taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'test-driver',
          },
        };
      },
    };

    const result = await new Arona(
      new Plana({
        runtime: ({ event }) =>
          event.kind === 'tool-invocation'
            ? vetoRuntime('policy veto')
            : undefined,
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-r4b-veto'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(sideEffectCalled).toBe(false);
    expect(evidence.cause.kind).toBe('runtime-veto');
    if (evidence.cause.kind === 'runtime-veto') {
      expect(evidence.cause.vetoSource).toBe('plana');
      expect(evidence.cause.cancellation?.cancelDetail?.originPort).toBe(
        'plana-runtime-review',
      );
    }
  });

  it('AC-R4b.8/15/16/17/19: approval state machine handles register/order/errors/timeout/concurrency', async () => {
    const approvals: Array<Promise<unknown>> = [];
    const errors: Error[] = [];
    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        approvals.push(
          context.requestApproval({
            request: { kind: 'unknown', reason: 'first' },
            deadline: new Date(Date.now() + 5).toISOString(),
          }),
        );
        approvals.push(
          context.requestApproval({
            request: { kind: 'unknown', reason: 'second' },
          }),
        );
        await Promise.allSettled(approvals);
        return {
          reason: 'approval checks complete',
          provenance: 'test-driver',
          cause: {
            kind: 'success',
            taskId: context.plan.taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'test-driver',
          },
        };
      },
    };

    class HarnessPlana extends Plana {
      override async consumeRuntimeStream(
        stream: RuntimeEventStream,
        ctx: RuntimeStreamContext,
      ) {
        for await (const event of stream.events) {
          if (event.kind !== 'approval.requested') continue;
          try {
            await ctx.approvalResponsePort.respond(
              'missing-id',
              { status: 'approved' },
              { provenance: 'plana-approval' },
            );
          } catch (error) {
            errors.push(error as Error);
          }
          if (event.request.reason === 'first') {
            await new Promise((resolve) => setTimeout(resolve, 10));
            try {
              await ctx.approvalResponsePort.respond(
                event.approvalRequestId,
                { status: 'approved' },
                { provenance: 'plana-approval' },
              );
            } catch (error) {
              errors.push(error as Error);
            }
          } else {
            await ctx.approvalResponsePort.respond(
              event.approvalRequestId,
              { status: 'approved' },
              { provenance: 'plana-approval' },
            );
            try {
              await ctx.approvalResponsePort.respond(
                event.approvalRequestId,
                { status: 'approved' },
                { provenance: 'plana-approval' },
              );
            } catch (error) {
              errors.push(error as Error);
            }
          }
        }
        return {
          terminalCause: 'stream-closed' as const,
          eventsConsumed: 0,
          vetoesEmitted: 0,
        };
      }
    }

    const plan = createDispatchPlan(createTaskRequest('task-r4b-approvals'));
    const evidence = await new AgentRuntime(runtimeDriver).execute(
      plan,
      new HarnessPlana(),
      createBoundary(plan.taskId),
    );
    expect(evidence.reason).toBe('approval checks complete');

    const settled = await Promise.allSettled(approvals);
    expect(settled[0]).toMatchObject({
      status: 'fulfilled',
      value: {
        status: 'timeout',
        reason: 'deadline-elapsed',
      },
    });
    expect(settled[1]).toMatchObject({
      status: 'fulfilled',
      value: { status: 'approved' },
    });

    expect(errors.some((error) => error instanceof UnknownApprovalRequestIdError)).toBe(
      true,
    );
    expect(errors.some((error) => error instanceof DuplicateApprovalResponseError)).toBe(
      true,
    );
    expect(errors.some((error) => error instanceof LateApprovalResponseError)).toBe(
      true,
    );
  });

  it('approval response provenance — agent-runtime surfaces the optional responseMeta as a structured warn line (signature drift fix)', async () => {
    // Audit 2026-05-03 follow-up: the prior `approvalResponsePort.respond`
    // implementation only accepted `(approvalRequestId, decision)` and
    // silently discarded the optional 3rd `responseMeta` declared on
    // `ApprovalResponsePort`. Plana already passes
    // `{ provenance: 'plana-approval' }` on every settle, so the audit
    // trail was being dropped at this seam. The fix preserves the
    // contract via `agent-runtime.approval-response` warn line.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        const decision = await context.requestApproval({
          request: { kind: 'command_execution', reason: 'meta-emit' },
        });
        return {
          reason: `approval ${decision.status}`,
          provenance: 'test-driver',
          cause: {
            kind: 'success',
            taskId: context.plan.taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'test-driver',
          },
        };
      },
    };

    class HarnessPlana extends Plana {
      override async consumeRuntimeStream(
        stream: RuntimeEventStream,
        ctx: RuntimeStreamContext,
      ) {
        for await (const event of stream.events) {
          if (event.kind !== 'approval.requested') continue;
          await ctx.approvalResponsePort.respond(
            event.approvalRequestId,
            { status: 'approved' },
            {
              provenance: 'plana-approval',
              respondedAt: '2026-05-03T12:00:00.000Z',
            },
          );
        }
        return {
          terminalCause: 'stream-closed' as const,
          eventsConsumed: 0,
          vetoesEmitted: 0,
        };
      }
    }

    const plan = createDispatchPlan(createTaskRequest('task-r4b-meta'));
    await new AgentRuntime(runtimeDriver).execute(
      plan,
      new HarnessPlana(),
      createBoundary(plan.taskId),
    );

    const warnCalls = warnSpy.mock.calls.flat();
    const matched = warnCalls.find(
      (line) =>
        typeof line === 'string' &&
        line.startsWith('agent-runtime.approval-response '),
    ) as string | undefined;
    expect(matched).toBeDefined();
    if (matched !== undefined) {
      const payload = JSON.parse(
        matched.slice('agent-runtime.approval-response '.length),
      );
      expect(payload.provenance).toBe('plana-approval');
      expect(payload.respondedAt).toBe('2026-05-03T12:00:00.000Z');
      expect(payload.decisionStatus).toBe('approved');
      expect(payload.taskId).toBe(plan.taskId);
      expect(typeof payload.approvalRequestId).toBe('string');
      expect(typeof payload.instanceId).toBe('string');
    }

    warnSpy.mockRestore();
  });

  it('approval response — agent-runtime emits no warn line when responseMeta is omitted (zero-behavior-change for legacy callers)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        const decision = await context.requestApproval({
          request: { kind: 'command_execution', reason: 'no-meta' },
        });
        return {
          reason: `approval ${decision.status}`,
          provenance: 'test-driver',
          cause: {
            kind: 'success',
            taskId: context.plan.taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'test-driver',
          },
        };
      },
    };

    class HarnessPlana extends Plana {
      override async consumeRuntimeStream(
        stream: RuntimeEventStream,
        ctx: RuntimeStreamContext,
      ) {
        for await (const event of stream.events) {
          if (event.kind !== 'approval.requested') continue;
          // Legacy 2-arg call shape (no responseMeta).
          await ctx.approvalResponsePort.respond(event.approvalRequestId, {
            status: 'approved',
          });
        }
        return {
          terminalCause: 'stream-closed' as const,
          eventsConsumed: 0,
          vetoesEmitted: 0,
        };
      }
    }

    const plan = createDispatchPlan(createTaskRequest('task-r4b-no-meta'));
    await new AgentRuntime(runtimeDriver).execute(
      plan,
      new HarnessPlana(),
      createBoundary(plan.taskId),
    );

    const warnCalls = warnSpy.mock.calls.flat();
    const matched = warnCalls.find(
      (line) =>
        typeof line === 'string' &&
        line.startsWith('agent-runtime.approval-response '),
    );
    expect(matched).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('AC-R4b.18: approval rejection remains step-scoped and emits item.failed', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        const decision = await context.requestApproval({
          request: { kind: 'command_execution', reason: 'reject-me' },
        });
        if (decision.status === 'rejected') {
          await context.emit({
            kind: 'item.failed',
            turnSequence: 1,
            item: {
              id: 'approval-step',
              type: 'command_execution',
              summary: 'approval-gated command',
            },
            failure: {
              message: decision.reason,
              code: 'approval-rejected',
            },
            provenance: {
              producer: 'codex-runtime-driver',
              sdkEventType: 'item.failed',
              threadId: null,
            },
          });
        }
        await context.emit({
          kind: 'agent-step',
          step: 'post-rejection-continuation',
          detail: 'run continues',
        });
        return {
          reason: 'continued after rejected approval',
          provenance: 'test-driver',
          cause: {
            kind: 'success',
            taskId: context.plan.taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'test-driver',
          },
        };
      },
    };

    const plana = new Plana({
      approval: () => ({ status: 'rejected', reason: 'policy denied' }),
    });
    const result = await new Arona(
      plana,
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-r4b-approval-rejected'));
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(evidence.reason).toBe('continued after rejected approval');
    expect(
      evidence.transcript?.events.some(
        (event) =>
          event.kind === 'item.failed' &&
          event.failure.code === 'approval-rejected',
      ),
    ).toBe(true);
  });

  it('AC-R4b.20: consumeRuntimeStream returns teardown report on signal abort', async () => {
    const ctrl = new AbortController();
    const stream = createRuntimeEventStream({ signal: ctrl.signal });
    const plan = createDispatchPlan(createTaskRequest('task-r4b-signal-abort'));
    const reportPromise = new Plana().consumeRuntimeStream(stream, {
      plan,
      instance: {
        taskId: plan.taskId,
        instanceId: 'agent-r4b-signal-abort',
        createdAt: new Date().toISOString(),
        runtimeSettings: plan.runtimeSettings,
      },
      cancellationBoundary: createBoundary(plan.taskId),
      approvalResponsePort: {
        async respond() {},
      },
      signal: ctrl.signal,
    });
    ctrl.abort();
    const report = await reportPromise;
    expect(report.terminalCause).toBe('signal-aborted');
  });

  it('AC-R4b.9/10/12/13/14 and C1 grep/contract guards', () => {
    const runtimeEventSource = readFileSync(
      resolve(process.cwd(), 'src/contracts/runtime-event.ts'),
      'utf8',
    );
    expect(runtimeEventSource).toMatch(/'runtime-initialized'/);
    expect(runtimeEventSource).toMatch(/'agent-step'/);
    expect(runtimeEventSource).toMatch(/'tool-invocation'/);

    const agentRuntimeSource = readFileSync(
      resolve(process.cwd(), 'src/runtime/agent-runtime.ts'),
      'utf8',
    );
    const dispatcherSource = readFileSync(
      resolve(process.cwd(), 'src/core/dispatcher.ts'),
      'utf8',
    );
    expect(agentRuntimeSource).not.toMatch(/plana\.reviewRuntime\(/);
    expect(dispatcherSource).not.toMatch(/plana\.reviewRuntime\(/);

    const srcFiles = [
      readFileSync(resolve(process.cwd(), 'src/core/plana.ts'), 'utf8'),
      readFileSync(resolve(process.cwd(), 'src/runtime/codex-runtime-adapter.ts'), 'utf8'),
      readFileSync(resolve(process.cwd(), 'src/runtime/agent-runtime.ts'), 'utf8'),
    ].join('\n');
    const streamIteratorHits =
      srcFiles.match(/for await\s*\(const .* of .*\.events\)/g) ?? [];
    expect(streamIteratorHits).toHaveLength(1);
    expect(streamIteratorHits[0]).toContain('stream.events');

    expect(
      readFileSync(resolve(process.cwd(), 'src/core/plana.ts'), 'utf8'),
    ).not.toMatch(/\btemplerun\b/);

    const terminalCauseSource = readFileSync(
      resolve(process.cwd(), 'src/contracts/terminal-cause.ts'),
      'utf8',
    );
    expect(terminalCauseSource).toMatch(/'plana-runtime-review'/);
    expect(terminalCauseSource).toMatch(/'plana'/);
  });
});
