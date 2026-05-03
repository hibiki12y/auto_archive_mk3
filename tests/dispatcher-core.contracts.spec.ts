import { withSynthesizedCause, synthesizeDriverCause, UNUSED_IDENTITY } from './helpers/wu-v-cause.js';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  createAbortEvidenceFromVeto,
  createDispatchPlan,
  createResourceEnvelope,
  createRuntimeEvent,
  createRuntimeSettingsBundle,
  createTerminalEvidence,
  projectNetworkPolicyProfile,
  vetoPreDispatch,
  type RuntimeDriver,
  type RuntimeSettingsBundle,
  type TaskRequest,
} from '../src/index.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

describe('dispatcher core contracts and boundary validation', () => {
  it('operator cancellation is surfaced as an explicit terminal outcome', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run() {
        return {
          reason: 'operator requested stop',
          provenance: 'dispatcher-operator',
          cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'operator-cancel', reason: 'operator requested stop', provenance: 'dispatcher-operator' }),
        };
      },
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-operator-cancel'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-operator-cancel',
        reason: 'operator requested stop',
        provenance: 'dispatcher-operator',
        abort: undefined,
      });
    }
  });

  it('timeout is surfaced as an explicit terminal outcome', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run() {
        return {
          reason: 'allocated wall time exhausted',
          provenance: 'runtime-deadline',
          cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'timeout', reason: 'allocated wall time exhausted', provenance: 'runtime-deadline' }),
          observedSummary: {
            wallTimeSec: 900,
          },
        };
      },
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-timeout'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-timeout',
        reason: 'allocated wall time exhausted',
        provenance: 'runtime-deadline',
        observedSummary: {
          wallTimeSec: 900,
        },
        abort: undefined,
      });
    }
  });

  it('abort evidence preserves explicit veto-path semantics for pre-dispatch vetoes', () => {
    const evidence = createAbortEvidenceFromVeto({
      taskId: 'task-veto-proof',
      runtimeInstanceId: 'agent-task-veto-proof',
      veto: vetoPreDispatch('submission blocked by policy', 'preflight-policy'),
      executionContext: {
        planCreatedAt: '2025-01-01T00:00:00.000Z',
        runtimeSettings: createRuntimeSettingsBundle({
          networkProfile: 'offline',
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
        }),
      },
      resourceEnvelope: createResourceEnvelope({
        requested: {
          cpuCores: 1,
          memoryMiB: 512,
          wallTimeSec: 60,
        },
      }),
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:00:01.000Z',
      cause: {
        kind: 'runtime-veto',
        taskId: 'task-veto-proof',
        runtimeInstanceId: 'agent-task-veto-proof',
        observedAt: '2025-01-01T00:00:01.000Z',
        provenance: 'preflight-policy',
        reason: 'submission blocked by policy',
        veto: vetoPreDispatch('submission blocked by policy', 'preflight-policy'),
      },
    });

    expect(evidence.abort).toMatchObject({
      kind: 'veto',
      veto: {
        origin: 'pre-dispatch',
        provenance: 'preflight-policy',
        propagation: {
          blocksSubmission: true,
          requestsCancellation: false,
          requestsTermination: false,
        },
      },
    });
    expect(evidence.executionContext).toEqual({
      planCreatedAt: '2025-01-01T00:00:00.000Z',
      runtimeSettings: {
        networkProfile: 'offline',
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkProjection: {
          networkAccessEnabled: false,
          webSearchMode: 'off',
        },
      },
    });
    expect(evidence.executionContext.runtimeSettings.deadlineMs).toBeUndefined();
  });

  it('terminal evidence clones and validates transcript snapshots', () => {
    const transcript = {
      events: [
        createRuntimeEvent({
          kind: 'runtime-initialized',
          message: 'agent instance created',
          instanceId: 'agent-transcript-proof',
          timestamp: '2025-01-01T00:00:00.000Z',
        }),
      ],
      droppedCount: 2,
    };

    const evidence = createTerminalEvidence({
      taskId: 'task-transcript-proof',
      runtimeInstanceId: 'agent-transcript-proof',
      reason: 'transcript attached',
      provenance: 'test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'transcript attached', provenance: 'test-driver' }),
      executionContext: {
        planCreatedAt: '2025-01-01T00:00:00.000Z',
        runtimeSettings: createRuntimeSettingsBundle({
          networkProfile: 'offline',
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
        }),
      },
      resourceEnvelope: createResourceEnvelope({
        requested: {
          cpuCores: 1,
          memoryMiB: 512,
          wallTimeSec: 60,
        },
      }),
      transcript,
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:00:01.000Z',
    });

    transcript.events[0] = createRuntimeEvent({
      kind: 'agent-step',
      step: 'mutated',
      instanceId: 'agent-transcript-proof',
      timestamp: '2025-01-01T00:00:02.000Z',
    });

    expect(evidence.transcript).toEqual({
      events: [
        {
          kind: 'runtime-initialized',
          message: 'agent instance created',
          instanceId: 'agent-transcript-proof',
          timestamp: '2025-01-01T00:00:00.000Z',
          observedSummary: undefined,
        },
      ],
      droppedCount: 2,
    });

    expect(() =>
      createTerminalEvidence({
        taskId: 'task-invalid-transcript-proof',
        runtimeInstanceId: 'agent-transcript-proof',
        reason: 'invalid transcript rejected',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'invalid transcript rejected', provenance: 'test-driver' }),
        executionContext: {
          planCreatedAt: '2025-01-01T00:00:00.000Z',
          runtimeSettings: createRuntimeSettingsBundle({
            networkProfile: 'offline',
            sandboxMode: 'read-only',
            approvalPolicy: 'never',
          }),
        },
        resourceEnvelope: createResourceEnvelope({
          requested: {
            cpuCores: 1,
            memoryMiB: 512,
            wallTimeSec: 60,
          },
        }),
        transcript: {
          events: transcript.events,
          droppedCount: -1,
        },
        startedAt: '2025-01-01T00:00:00.000Z',
        endedAt: '2025-01-01T00:00:01.000Z',
      }),
    ).toThrow('terminal transcript droppedCount must be a non-negative integer.');
  });

  it('runtime settings bundle canonically carries reviewed execution settings', () => {
    expect(
      createRuntimeSettingsBundle({
        networkProfile: 'offline',
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
      }),
    ).toEqual({
      networkProfile: 'offline',
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkProjection: {
        networkAccessEnabled: false,
        webSearchMode: 'off',
      },
    });

    expect(
      createRuntimeSettingsBundle({
        networkProfile: 'provider-only',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        workingDirectory: 'results/task-artifacts',
      }),
    ).toEqual({
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: 'results/task-artifacts',
      networkProjection: projectNetworkPolicyProfile('provider-only'),
    });

    expect(
      createRuntimeSettingsBundle({
        networkProfile: 'restricted-egress',
        sandboxMode: 'read-only',
        approvalPolicy: 'on-request',
      }).networkProjection.networkAccessEnabled,
    ).toBe(true);
    expect(
      createRuntimeSettingsBundle({
        networkProfile: 'open-egress',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      }).networkProjection.networkAccessEnabled,
    ).toBe(true);
  });

  it('runtime settings bundle is frozen across plan and runtime handoff', async () => {
    let mutationError: Error | undefined;

    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        expect(Object.isFrozen(context.plan.runtimeSettings)).toBe(true);
        expect(Object.isFrozen(context.plan.runtimeSettings.networkProjection)).toBe(true);
        expect(context.instance.runtimeSettings).toBe(context.plan.runtimeSettings);

        try {
          (
            context.plan.runtimeSettings as RuntimeSettingsBundle & {
              sandboxMode: 'read-only' | 'workspace-write';
            }
          ).sandboxMode = 'read-only';
        } catch (error) {
          mutationError = error as Error;
        }

        expect(context.plan.runtimeSettings.sandboxMode).toBe('workspace-write');

        return withSynthesizedCause(context, {
          outcome: 'success',
          reason: 'immutability check completed',
          provenance: 'test-driver',
        });
      },
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-frozen-runtime'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        reason: 'immutability check completed',
      });
    }
    expect(mutationError).toBeInstanceOf(TypeError);
  });

  it('runtime settings validation rejects invalid runtime values at bundle creation', () => {
    expect(() =>
      createRuntimeSettingsBundle({
        networkProfile: 'invalid-profile' as RuntimeSettingsBundle['networkProfile'],
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      }),
    ).toThrow(/networkProfile must be one of:/);

    expect(() =>
      createRuntimeSettingsBundle({
        networkProfile: 'offline',
        sandboxMode: 'invalid-sandbox' as RuntimeSettingsBundle['sandboxMode'],
        approvalPolicy: 'on-request',
      }),
    ).toThrow(/sandboxMode must be one of:/);

    expect(() =>
      createRuntimeSettingsBundle({
        networkProfile: 'offline',
        sandboxMode: 'read-only',
        approvalPolicy: 'invalid-approval' as RuntimeSettingsBundle['approvalPolicy'],
      }),
    ).toThrow(/approvalPolicy must be one of:/);

    expect(() =>
      createRuntimeSettingsBundle({
        networkProfile: 'offline',
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        workingDirectory: 42 as unknown as string,
      }),
    ).toThrow(/workingDirectory must be a string when provided/);

    for (const invalidDeadline of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '500' as unknown as number,
    ]) {
      expect(() =>
        createRuntimeSettingsBundle({
          networkProfile: 'offline',
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          deadlineMs: invalidDeadline,
        }),
      ).toThrow(/deadlineMs must be a finite positive integer when provided/);
    }

    expect(
      createRuntimeSettingsBundle({
        networkProfile: 'offline',
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        deadlineMs: 1_500,
      }).deadlineMs,
    ).toBe(1_500);
  });

  it('network projection rejects invalid policy profiles at runtime', () => {
    expect(() =>
      projectNetworkPolicyProfile(
        'invalid-profile' as RuntimeSettingsBundle['networkProfile'],
      ),
    ).toThrow(/networkProfile must be one of:/);
  });

  it('dispatch planning rejects observed resources while runtime evidence can still attach them later', () => {
    expect(() =>
      createDispatchPlan({
        taskId: 'task-observed-plan',
        instruction: 'Reject observed data at planning time',
        runtimeSettings: {
          networkProfile: 'offline',
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
        },
        artifactLocation: 'results/task-artifacts',
        resources: {
          requested: {
            cpuCores: 2,
            memoryMiB: 2048,
            wallTimeSec: 300,
          },
          observed: {
            cpuCoresPeak: 3,
          },
        } as TaskRequest['resources'] & {
          observed: {
            cpuCoresPeak: number;
          };
        },
      }),
    ).toThrow(
      /observed resource usage is runtime evidence and cannot be supplied for dispatch planning/,
    );

    expect(() =>
      createResourceEnvelope({
        requested: {
          cpuCores: 4,
          memoryMiB: 4096,
          wallTimeSec: 600,
        },
        effective: {
          cpuCores: 5,
        },
      }),
    ).toThrow(/effective cpuCores must not exceed requested cpuCores/);

    expect(
      createResourceEnvelope({
        requested: {
          cpuCores: 2,
          memoryMiB: 2048,
          wallTimeSec: 300,
        },
        observed: {
          cpuCoresPeak: 3,
          memoryMiBPeak: 4096,
        },
      }),
    ).toMatchObject({
      requested: {
        cpuCores: 2,
        memoryMiB: 2048,
        wallTimeSec: 300,
        gpuCards: 0,
      },
      effective: {
        cpuCores: 2,
        memoryMiB: 2048,
        wallTimeSec: 300,
        gpuCards: 0,
      },
      observed: {
        cpuCoresPeak: 3,
        memoryMiBPeak: 4096,
      },
    });
  });

  it('dispatch planning rejects blank task identifiers', () => {
    expect(() => createDispatchPlan(createTaskRequest('   '))).toThrowError(
      'taskId must be a meaningful string.',
    );

    expect(() =>
      createDispatchPlan({
        ...createTaskRequest('task-non-string-id'),
        taskId: 42 as unknown as string,
      }),
    ).toThrowError('taskId must be a meaningful string.');
  });

  it('dispatch planning rejects malformed top-level request values with boundary errors', () => {
    expect(() => createDispatchPlan(null as unknown as TaskRequest)).toThrowError(
      'request must be an object.',
    );
    expect(() => createDispatchPlan([] as unknown as TaskRequest)).toThrowError(
      'request must be an object.',
    );
  });

  it('dispatch planning rejects malformed resource payloads with boundary errors', () => {
    expect(() =>
      createDispatchPlan({
        ...createTaskRequest('task-null-resources'),
        resources: null as unknown as TaskRequest['resources'],
      }),
    ).toThrowError('resources must be an object.');

    expect(() =>
      createDispatchPlan({
        ...createTaskRequest('task-null-requested-resources'),
        resources: {
          requested: null as unknown as TaskRequest['resources']['requested'],
        },
      }),
    ).toThrowError('resources.requested must be an object.');

    expect(() =>
      createDispatchPlan({
        ...createTaskRequest('task-null-effective-resources'),
        resources: {
          requested: {
            cpuCores: 1,
            memoryMiB: 512,
            wallTimeSec: 60,
          },
          effective: null as unknown as NonNullable<TaskRequest['resources']>['effective'],
        },
      }),
    ).toThrowError('resources.effective must be an object.');
  });

  it('dispatch planning rejects blank instructions', () => {
    expect(() =>
      createDispatchPlan(
        createTaskRequest('task-blank-instruction', {
          instruction: ' \n\t ',
        }),
      ),
    ).toThrowError('instruction must be a meaningful string.');
  });

  it('dispatch planning validates artifact location when provided', () => {
    expect(() =>
      createDispatchPlan(
        createTaskRequest('task-blank-artifact-location', {
          artifactLocation: '   ',
        }),
      ),
    ).toThrowError('artifactLocation must be a meaningful string when provided.');

    expect(() =>
      createDispatchPlan({
        ...createTaskRequest('task-non-string-artifact-location'),
        artifactLocation: 42 as unknown as string,
      }),
    ).toThrowError('artifactLocation must be a meaningful string when provided.');
  });
});
