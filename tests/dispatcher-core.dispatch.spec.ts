import { synthesizeDriverCause, UNUSED_IDENTITY } from './helpers/wu-v-cause.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveOutcomeFromCause } from '../src/core/derive-outcome.js';

const codexMockState = vi.hoisted(() => ({
  constructorArgs: [] as unknown[],
  startThreadMock: vi.fn(),
  runStreamedMock: vi.fn(),
}));

vi.mock('@openai/codex-sdk', () => {
  class Codex {
    constructor(options?: unknown) {
      codexMockState.constructorArgs.push(options);
    }

    startThread(options?: unknown): {
      readonly id: string;
      runStreamed: typeof codexMockState.runStreamedMock;
    } {
      codexMockState.startThreadMock(options);
      return {
        id: 'thread-dispatch-spec',
        runStreamed: codexMockState.runStreamedMock,
      };
    }
  }

  return { Codex };
});

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  DuplicateSubmissionError,
  Plana,
  createDispatchPlan,
  projectNetworkPolicyProfile,
  vetoRuntimeSettings,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeSettingsBundle,
} from '../src/index.js';
import {
  createControlledPromise,
  createTaskRequest,
} from './helpers/dispatcher-core.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

function streamEvents(events: unknown[]) {
  return (async function* (): AsyncGenerator<unknown> {
    for (const event of events) {
      yield event;
    }
  })();
}

beforeEach(() => {
  codexMockState.constructorArgs.length = 0;
  codexMockState.startThreadMock.mockReset();
  codexMockState.runStreamedMock.mockReset();
  codexMockState.runStreamedMock.mockResolvedValue({
    events: streamEvents([
      {
        type: 'item.completed',
        item: {
          id: 'agent-message-1',
          type: 'agent_message',
          text: 'codex driver completed the task',
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 4,
        },
      },
    ]),
  });
});

describe('dispatcher core dispatch flow', () => {
  it('pre-dispatch veto stops submission and returns a veto result', async () => {
    let reviewedRuntimeSettings: RuntimeSettingsBundle | undefined;
    const plana = new Plana({
      preDispatch: (plan) => {
        reviewedRuntimeSettings = plan.runtimeSettings;
        return {
          origin: 'pre-dispatch',
          reason: 'insufficient justification for dispatch',
          provenance: 'plana-policy',
          propagation: {
            blocksSubmission: true,
            requestsCancellation: false,
            requestsTermination: false,
          },
        };
      },
    });
    const dispatcher = new Dispatcher(new InProcessComputeNode());
    const arona = new Arona(plana, dispatcher);

    const result = await arona.requestDispatch(createTaskRequest('task-veto-pre'));

    expect(result.kind).toBe('vetoed');
    if (result.kind === 'vetoed') {
      expect(result.veto.origin).toBe('pre-dispatch');
      expect(result.veto.propagation.blocksSubmission).toBe(true);
      expect(result.veto.provenance).toBe('plana-policy');
    }
    expect(reviewedRuntimeSettings).toMatchObject({
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: 'results/task-artifacts',
      networkProjection: projectNetworkPolicyProfile('provider-only'),
    });
    expect(dispatcher.submissionCount).toBe(0);
  });

  it('approved plan goes through dispatcher and produces terminal evidence', async () => {
    const plana = new Plana();
    const dispatcher = new Dispatcher(new InProcessComputeNode());
    const arona = new Arona(plana, dispatcher);

    const result = await arona.requestDispatch(createTaskRequest('task-success'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      expect(result.submission.acceptance).toMatchObject({
        taskId: 'task-success',
        boundary: 'dispatcher',
      });

      const evidence = await result.submission.completion;
      expect(evidence.taskId).toBe('task-success');
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
      expect(evidence.provenance).toBe('codex-runtime-driver');
      expect(evidence.reason).toBe('codex driver completed the task');
      expect(evidence.runtimeInstanceId).toContain('task-success');
      expect(evidence.executionContext).toMatchObject({
        planCreatedAt: result.plan.createdAt,
        runtimeSettings: result.plan.runtimeSettings,
      });
      expect(evidence.executionContext.executionStartedAt).toBeDefined();
      expect(evidence.executionContext.settingsReview).toEqual({
        status: 'approved',
        reviewedAt: expect.any(String),
      });
      expect(evidence.executionContext.runtimeSettings).not.toBe(
        result.plan.runtimeSettings,
      );
      expect(evidence.resourceEnvelope.requested.cpuCores).toBe(4);
      expect(codexMockState.constructorArgs).toHaveLength(1);
      expect(codexMockState.constructorArgs[0]).toEqual(
        expect.objectContaining({}),
      );
      expect(codexMockState.startThreadMock).toHaveBeenCalledWith({
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        networkAccessEnabled: true,
        webSearchMode: 'live',
        skipGitRepoCheck: true,
        workingDirectory: 'results/task-artifacts',
      });
      expect(codexMockState.runStreamedMock).toHaveBeenCalledWith(
        'Execute contract-first runtime skeleton',
        {
          signal: expect.any(AbortSignal),
        },
      );
    }
    expect(dispatcher.submissionCount).toBe(1);
  });

  it('duplicate submission rejection stays explicit at the dispatcher boundary', async () => {
    const plana = new Plana();
    const dispatcher = new Dispatcher(new InProcessComputeNode());
    const firstPlan = createDispatchPlan(createTaskRequest('task-duplicate'));

    const firstSubmission = dispatcher.submit(firstPlan, plana);
    const duplicateSubmit = (): void => {
      dispatcher.submit(createDispatchPlan(createTaskRequest('task-duplicate')), plana);
    };

    expect(firstSubmission.acceptance.taskId).toBe('task-duplicate');
    expect(duplicateSubmit).toThrowError(DuplicateSubmissionError);
    expect(duplicateSubmit).toThrowError(
      'task task-duplicate has already been submitted; runtime sessions are single-use',
    );

    await expect(firstSubmission.completion).resolves.toMatchObject({
      taskId: 'task-duplicate',
    });
    expect(dispatcher.submissionCount).toBe(1);
  });

  it('dispatcher acceptance returns before runtime completion resolves', async () => {
    let releaseDriverResult: ((value: RuntimeDriverResult) => void) | undefined;
    let planSettingsSeenByRuntime: RuntimeSettingsBundle | undefined;
    let instanceSettingsSeenByRuntime: RuntimeSettingsBundle | undefined;

    const runtimeDriver: RuntimeDriver = {
      run: vi.fn((context) => {
        planSettingsSeenByRuntime = context.plan.runtimeSettings;
        instanceSettingsSeenByRuntime = context.instance.runtimeSettings;
        return new Promise<RuntimeDriverResult>((resolve) => {
          releaseDriverResult = resolve;
        });
      }),
    };
    const runSpy = vi.mocked(runtimeDriver.run);
    const arona = new Arona(new Plana(), new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))));

    const result = await arona.requestDispatch(
      createTaskRequest('task-accepted-before-complete'),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      expect(result.submission.acceptance).toMatchObject({
        taskId: 'task-accepted-before-complete',
        boundary: 'dispatcher',
      });
      for (let i = 0; i < 8 && runSpy.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(runtimeDriver.run).toHaveBeenCalledTimes(1);
      expect(planSettingsSeenByRuntime).toMatchObject({
        networkProfile: 'provider-only',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      });
      expect(instanceSettingsSeenByRuntime).toEqual(planSettingsSeenByRuntime);

      const completionObserver = vi.fn();
      void result.submission.completion.then(completionObserver);
      await Promise.resolve();
      expect(completionObserver).not.toHaveBeenCalled();

      releaseDriverResult?.({
        reason: 'deferred runtime completed',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'deferred runtime completed', provenance: 'test-driver' }),
      });

      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-accepted-before-complete',
        reason: 'deferred runtime completed',
        provenance: 'test-driver',
      });
    }
  });

  it('external dispatcher cancel settles completion before a pending driver resolves', async () => {
    const driverExecution = createControlledPromise<RuntimeDriverResult>();
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(() => driverExecution.promise),
    };
    const dispatcher = new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver)));
    const arona = new Arona(new Plana(), dispatcher);

    const result = await arona.requestDispatch(createTaskRequest('task-external-cancel'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const completionObserver = vi.fn();
      void result.submission.completion.then(completionObserver);
      await Promise.resolve();
      expect(completionObserver).not.toHaveBeenCalled();

      expect(
        dispatcher.cancel('task-external-cancel', 'operator requested stop'),
      ).toMatchObject({
        taskId: 'task-external-cancel',
        reason: 'operator requested stop',
        provenance: 'dispatcher',
        status: 'accepted',
      });

      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-external-cancel',
        reason: 'operator requested stop',
        provenance: 'dispatcher',
        abort: undefined,
      });

      driverExecution.resolve({
        reason: 'driver completed after external cancel',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver completed after external cancel', provenance: 'test-driver' }),
      });
      await Promise.resolve();
    }
  });

  it('dispatcher cancel reports not-active when no live submission exists', () => {
    const dispatcher = new Dispatcher(new InProcessComputeNode());

    expect(
      dispatcher.cancel('task-no-active-submission', 'operator requested stop'),
    ).toMatchObject({
      taskId: 'task-no-active-submission',
      reason: 'operator requested stop',
      provenance: 'dispatcher',
      status: 'not-active',
    });
  });

  it('driver-first settlement is not overwritten by a late external cancel', async () => {
    let dispatcher: Dispatcher | undefined = undefined;
    let lateCancellationReceipt:
      | ReturnType<Dispatcher['cancel']>
      | undefined;
    const runtimeDriver: RuntimeDriver = {
      async run() {
        return {
          outcome: 'success',
          reason: 'driver completed before cancel',
          provenance: 'test-driver',
          cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver completed before cancel', provenance: 'test-driver' }),
          get artifactLocation() {
            lateCancellationReceipt = dispatcher?.cancel(
              'task-driver-first-cancel-late',
              'operator requested stop too late',
            );
            return 'results/task-artifacts';
          },
        };
      },
    };
    dispatcher = new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver)));

    const result = await new Arona(new Plana(), dispatcher).requestDispatch(
      createTaskRequest('task-driver-first-cancel-late'),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-driver-first-cancel-late',
        reason: 'driver completed before cancel',
        provenance: 'test-driver',
      });
      expect(lateCancellationReceipt).toMatchObject({
        taskId: 'task-driver-first-cancel-late',
        reason: 'operator requested stop too late',
        provenance: 'dispatcher',
        status: 'not-active',
      });
    }
  });

  it('runtime-settings veto aborts before driver runs and before runtime hook observes init', async () => {
    const runtimeHook = vi.fn(() => undefined);
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'unexpected success',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'unexpected success', provenance: 'test-driver' }),
      })),
    };

    const result = await new Arona(
      new Plana({
        runtime: runtimeHook,
        runtimeSettings: ({ instance }) =>
          instance.runtimeSettings.sandboxMode === 'workspace-write'
            ? vetoRuntimeSettings(
                'sandbox-mode workspace-write not permitted',
                'plana-runtime-settings',
              )
            : undefined,
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-veto-runtime-settings'));

    expect(result.kind).toBe('dispatched');
    expect(runtimeDriver.run).not.toHaveBeenCalled();
    expect(runtimeHook).not.toHaveBeenCalled();
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
      expect(evidence.reason).toBe('sandbox-mode workspace-write not permitted');
      expect(evidence.provenance).toBe('plana-runtime-settings');
      expect(evidence.abort).toMatchObject({
        kind: 'veto',
        veto: {
          origin: 'runtime',
          provenance: 'plana-runtime-settings',
          propagation: {
            blocksSubmission: false,
            requestsCancellation: true,
            requestsTermination: true,
          },
        },
        cancellation: {
          taskId: 'task-veto-runtime-settings',
          reason: 'sandbox-mode workspace-write not permitted',
          provenance: 'dispatcher-runtime-veto',
          boundary: 'dispatcher',
        },
      });
    }
  });

  it('runtime-settings review approves by default and preserves success path', async () => {
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'driver finished cleanly',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver finished cleanly', provenance: 'test-driver' }),
      })),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-runtime-settings-approved'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
      expect(evidence.reason).toBe('driver finished cleanly');
      expect(runtimeDriver.run).toHaveBeenCalledTimes(1);
    }
  });
});
