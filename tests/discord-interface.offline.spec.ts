import { withSynthesizedCause, synthesizeDriverCause, UNUSED_IDENTITY } from './helpers/wu-v-cause.js';
import { describe, expect, it, vi } from 'vitest';
import { deriveOutcomeFromCause } from '../src/core/derive-outcome.js';

import {
  AgentRuntime,
  Arona,
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  Dispatcher,
  Plana,
  createDispatchPlan,
  vetoPreDispatch,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type TerminalEvidence,
} from '../src/index.js';
import { createControlledPromise } from './helpers/dispatcher-core.js';
import {
  FakeDiscordInteraction,
  flushDiscordAsyncWork,
} from './helpers/discord.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

const defaultRequestFactoryOptions = {
  resources: {
    requested: {
      cpuCores: 4,
      memoryMiB: 8192,
      wallTimeSec: 900,
      gpuCards: 0,
    },
  },
  runtimeSettings: {
    networkProfile: 'provider-only' as const,
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'on-request' as const,
    workingDirectory: 'results/task-artifacts',
  },
  artifactLocation: 'results/task-artifacts',
};

function createHandlers(options: {
  plana?: Plana;
  runtimeDriver?: RuntimeDriver;
  taskIdFactory?: () => string;
}) {
  const dispatcher = new Dispatcher(new InProcessComputeNode(new AgentRuntime(
      options.runtimeDriver ?? {
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'complete',
            detail: 'offline-discord-flow',
          });
          return withSynthesizedCause(context, {
            outcome: 'success',
            reason: 'discord handler completed the task',
            provenance: 'discord-offline-test-driver',
            artifactLocation: 'results/discord-task',
          });
        },
      },
    )),);
  const taskRegistry = new DiscordTaskRegistry();
  const handlers = new DiscordCommandHandlers({
    arona: new Arona(options.plana ?? new Plana(), dispatcher),
    dispatcher,
    taskRegistry,
    requestFactory: new DefaultDiscordTaskRequestFactory({
      ...defaultRequestFactoryOptions,
      taskIdFactory: options.taskIdFactory ?? (() => 'fixed-task-id'),
    }),
  });

  return {
    dispatcher,
    taskRegistry,
    handlers,
  };
}

describe('discord interface first slice offline integration', () => {
  it('scopes managed artifact output by task id and injects the publication contract', () => {
    const request = new DefaultDiscordTaskRequestFactory({
      ...defaultRequestFactoryOptions,
      taskIdFactory: () => 'fixed-task-id',
    }).createAskTaskRequest({
      instruction: 'create a VM',
      userId: 'user-1',
    });

    expect(request.taskId).toBe('discord-task-fixed-task-id');
    expect(request.artifactLocation).toBe(
      'results/task-artifacts/discord-task-fixed-task-id',
    );
    expect(request.instruction).toContain('AUTO_ARCHIVE MANAGED ARTIFACT OUTPUT');
    expect(request.instruction).toContain(
      'Artifact root: results/task-artifacts/discord-task-fixed-task-id',
    );
    expect(request.instruction).toContain(
      'Auto Archive will publish this artifact root to the assigned GitLab project',
    );
  });

  it('/ask reports the veto path without tracking a task', async () => {
    const { handlers, taskRegistry } = createHandlers({
      plana: new Plana({
        preDispatch: () => vetoPreDispatch('blocked by policy', 'discord-policy'),
      }),
    });
    const interaction = new FakeDiscordInteraction('ask', {
      instruction: 'refuse this request',
    });

    await handlers.handleInteraction(interaction);

    expect(interaction.editedReplies).toHaveLength(1);
    expect(interaction.editedReplies[0].content).toContain('Dispatch vetoed');
    expect(interaction.editedReplies[0].content).toContain('blocked by policy');
    expect(taskRegistry.get('fixed-task-id')).toBeUndefined();
  });

  it('/ask dispatches through the core, emits coarse running, and delivers terminal output', async () => {
    const { handlers, taskRegistry } = createHandlers({});
    const interaction = new FakeDiscordInteraction('ask', {
      instruction: 'run the task',
    });

    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    expect(interaction.editedReplies).toHaveLength(1);
    expect(interaction.editedReplies[0].content).toContain('Accepted task `discord-task-fixed-task-id`');
    expect(interaction.followUpReplies.some((payload) => payload.content.includes('is running'))).toBe(true);
    expect(interaction.followUpReplies.some((payload) => payload.content.includes('finished with `success`'))).toBe(true);

    const record = taskRegistry.get('discord-task-fixed-task-id');
    expect(record?.coarseState).toBe('terminal');
    expect(record?.terminalEvidence).toMatchObject({
      reason: 'discord handler completed the task',
      provenance: 'discord-offline-test-driver',
      artifactLocation: 'results/discord-task',
    });
  });

  it('/ask converts a rejected completion promise into terminal failure evidence', async () => {
    const taskRegistry = new DiscordTaskRegistry();
    const requestFactory = new DefaultDiscordTaskRequestFactory({
      ...defaultRequestFactoryOptions,
      taskIdFactory: () => 'completion-reject-id',
    });
    const handlers = new DiscordCommandHandlers({
      arona: {
        async requestDispatch(request: Parameters<Arona['requestDispatch']>[0]) {
          const plan = createDispatchPlan(request);
          const completion = new Promise<TerminalEvidence>((_resolve, reject) => {
            setImmediate(() => reject(new Error('completion observer boom')));
          });
          return {
            kind: 'dispatched',
            plan,
            submission: {
              acceptance: {
                taskId: plan.taskId as never,
                acceptedAt: plan.createdAt,
                boundary: 'dispatcher',
              },
              completion,
            },
          };
        },
      } as never,
      dispatcher: {} as never,
      taskRegistry,
      requestFactory,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const interaction = new FakeDiscordInteraction('ask', {
      instruction: 'run but reject completion',
    });

    try {
      await handlers.handleInteraction(interaction);
      await flushDiscordAsyncWork();
    } finally {
      warn.mockRestore();
    }

    const terminalReply = interaction.followUpReplies.find((payload) =>
      payload.content.includes('finished with `failure`'),
    );
    expect(terminalReply).toBeDefined();
    expect(terminalReply?.content).toContain('Driver phase: dispatch-completion-observer');
    expect(terminalReply?.content).toContain('Driver message: completion observer boom');
    const record = taskRegistry.get('discord-task-completion-reject-id');
    expect(record?.coarseState).toBe('terminal');
    expect(record?.terminalEvidence).toMatchObject({
      reason: 'Dispatch completion rejected: completion observer boom',
      provenance: 'discord-command-handler',
      cause: {
        kind: 'driver-failure',
        phase: 'dispatch-completion-observer',
        message: 'completion observer boom',
      },
    });
  });

  it('/status reports active, terminal, and unknown task identifiers', async () => {
    const driverExecution = createControlledPromise<RuntimeDriverResult>();
    const { handlers, taskRegistry } = createHandlers({
      runtimeDriver: {
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'waiting',
          });
          return driverExecution.promise;
        },
      },
      taskIdFactory: () => 'status-task-id',
    });

    await handlers.handleInteraction(
      new FakeDiscordInteraction('ask', {
        instruction: 'run slowly',
      }),
    );

    const activeStatus = new FakeDiscordInteraction('status', {
      task_id: 'discord-task-status-task-id',
    });
    await handlers.handleInteraction(activeStatus);

    expect(activeStatus.editedReplies[0].content).toContain('status: running');

    driverExecution.resolve({
      reason: 'slow task completed',
      provenance: 'discord-offline-test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'slow task completed', provenance: 'discord-offline-test-driver' }),
      artifactLocation: 'results/slow-task',
    });
    await flushDiscordAsyncWork();

    const terminalStatus = new FakeDiscordInteraction('status', {
      task_id: 'discord-task-status-task-id',
    });
    await handlers.handleInteraction(terminalStatus);

    expect(terminalStatus.editedReplies[0].content).toContain('finished with `success`');
    expect(taskRegistry.get('discord-task-status-task-id')?.coarseState).toBe('terminal');

    const unknownStatus = new FakeDiscordInteraction('status', {
      task_id: 'discord-task-unknown',
    });
    await handlers.handleInteraction(unknownStatus);

    expect(unknownStatus.editedReplies[0].content).toContain('is not tracked');
  });

  it('/cancel cancels an active task and the registry settles to terminal output', async () => {
    const driverExecution = createControlledPromise<RuntimeDriverResult>();
    const { handlers, taskRegistry } = createHandlers({
      runtimeDriver: {
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'waiting',
          });
          return driverExecution.promise;
        },
      },
      taskIdFactory: () => 'cancel-task-id',
    });
    const askInteraction = new FakeDiscordInteraction('ask', {
      instruction: 'wait for cancel',
    });

    await handlers.handleInteraction(askInteraction);

    const cancelInteraction = new FakeDiscordInteraction('cancel', {
      task_id: 'discord-task-cancel-task-id',
      reason: 'operator stop',
    });
    await handlers.handleInteraction(cancelInteraction);
    await flushDiscordAsyncWork();

    expect(cancelInteraction.editedReplies[0].content).toContain('Cancellation requested');
    expect(taskRegistry.get('discord-task-cancel-task-id')?.cancellationReceipt).toMatchObject({
      reason: 'operator stop',
      provenance: 'discord-interface',
      status: 'accepted',
    });

    await flushDiscordAsyncWork();

    const terminalRecord = taskRegistry.get('discord-task-cancel-task-id');
    expect(terminalRecord?.coarseState).toBe('terminal');
    expect(terminalRecord?.terminalEvidence?.cause && deriveOutcomeFromCause(terminalRecord.terminalEvidence.cause)).toBe('operator-cancel');

    driverExecution.resolve({
      reason: 'late success',
      provenance: 'discord-offline-test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'late success', provenance: 'discord-offline-test-driver' }),
    });
  });

  it('/cancel reports already-terminal tasks without issuing another cancel request', async () => {
    const { handlers, taskRegistry } = createHandlers({
      taskIdFactory: () => 'already-terminal-id',
    });

    await handlers.handleInteraction(
      new FakeDiscordInteraction('ask', {
        instruction: 'finish immediately',
      }),
    );
    await flushDiscordAsyncWork();

    const cancelInteraction = new FakeDiscordInteraction('cancel', {
      task_id: 'discord-task-already-terminal-id',
    });
    await handlers.handleInteraction(cancelInteraction);

    expect(cancelInteraction.editedReplies[0].content).toContain('already terminal');
    expect(taskRegistry.get('discord-task-already-terminal-id')?.terminalEvidence?.cause && deriveOutcomeFromCause(taskRegistry.get('discord-task-already-terminal-id')!.terminalEvidence!.cause)).toBe(
      'success',
    );
  });

  it('/cancel distinguishes dispatcher no-op acknowledgement races from active cancellation', async () => {
    const driverExecution = createControlledPromise<RuntimeDriverResult>();
    const { dispatcher, handlers, taskRegistry } = createHandlers({
      runtimeDriver: {
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'waiting',
          });
          return driverExecution.promise;
        },
      },
      taskIdFactory: () => 'noop-cancel-id',
    });
    await handlers.handleInteraction(
      new FakeDiscordInteraction('ask', {
        instruction: 'wait for raced cancel',
      }),
    );

    vi.spyOn(dispatcher, 'cancel').mockReturnValue({
      taskId: 'discord-task-noop-cancel-id',
      reason: 'operator stop',
      provenance: 'discord-interface',
      requestedAt: new Date().toISOString(),
      status: 'not-active',
    });

    const cancelInteraction = new FakeDiscordInteraction('cancel', {
      task_id: 'discord-task-noop-cancel-id',
      reason: 'operator stop',
    });
    await handlers.handleInteraction(cancelInteraction);

    expect(cancelInteraction.editedReplies[0].content).toContain(
      'Cancellation was not applied',
    );
    expect(cancelInteraction.editedReplies[0].content).toContain(
      'no longer active',
    );
    expect(taskRegistry.get('discord-task-noop-cancel-id')?.cancellationReceipt).toBeUndefined();

    driverExecution.resolve({
      reason: 'late success',
      provenance: 'discord-offline-test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'late success', provenance: 'discord-offline-test-driver' }),
    });
  });

  it('/cancel reports untracked task identifiers without issuing a dispatcher cancel', async () => {
    const { dispatcher, handlers } = createHandlers({});
    const cancelSpy = vi.spyOn(dispatcher, 'cancel');
    const cancelInteraction = new FakeDiscordInteraction('cancel', {
      task_id: 'discord-task-untracked',
      reason: 'operator stop',
    });

    await handlers.handleInteraction(cancelInteraction);

    expect(cancelInteraction.editedReplies[0].content).toContain('is not tracked');
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('records observed marker audit updates through the live handler seam', () => {
    const { handlers, taskRegistry } = createHandlers({});
    taskRegistry.registerTask({
      taskId: 'discord-task-fixed-task-id',
      instruction: 'run the task',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance: {
        taskId: 'discord-task-fixed-task-id' as never,
        acceptedAt: '2026-04-26T00:00:00.000Z',
        boundary: 'dispatcher',
      },
    });

    const record = handlers.recordObservedMarkerAudit('discord-task-fixed-task-id', {
      observedAt: '2026-04-26T00:00:05.000Z',
      marker: 'RUN_T12',
      matchedReply: {
        status: 'captured',
        matchedOn: ['marker', 'task-id'],
      },
    });

    expect(record.markerAudit).toMatchObject({
      marker: 'RUN_T12',
      matchedReply: {
        status: 'captured',
        matchedOn: ['marker', 'task-id'],
      },
    });
    expect(taskRegistry.get('discord-task-fixed-task-id')?.markerAudit).toMatchObject({
      marker: 'RUN_T12',
    });
  });

  it('rejects invalid or untracked marker audit observations through the live handler seam', () => {
    const { handlers } = createHandlers({});

    expect(() =>
      handlers.recordObservedMarkerAudit('   ', {
        observedAt: '2026-04-26T00:00:05.000Z',
      }),
    ).toThrow('taskId is required to record marker audit observations');
    expect(() =>
      handlers.recordObservedMarkerAudit('discord-task-missing', {
        observedAt: '2026-04-26T00:00:05.000Z',
      }),
    ).toThrow('Task `discord-task-missing` is not tracked.');
  });
});
