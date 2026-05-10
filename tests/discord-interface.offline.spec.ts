import { withSynthesizedCause, synthesizeDriverCause, UNUSED_IDENTITY } from './helpers/wu-v-cause.js';
import { describe, expect, it, vi } from 'vitest';
import { deriveOutcomeFromCause } from '../src/core/derive-outcome.js';

import {
  AgentRuntime,
  Arona,
  DefaultDiscordTaskRequestFactory,
  DiscordAccessPolicy,
  DiscordCommandHandlers,
  DiscordDeliveryQueue,
  DiscordTaskRegistry,
  Dispatcher,
  Plana,
  createDispatchPlan,
  vetoPreDispatch,
  type DiscordDeliveryFn,
  type DiscordDeliveryRequest,
  type DiscordDeliveryResult,
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

class RecordingDiscordDeliveryQueue extends DiscordDeliveryQueue {
  readonly requests: DiscordDeliveryRequest[] = [];

  override async enqueue(
    request: DiscordDeliveryRequest,
    deliveryFn: DiscordDeliveryFn,
  ): Promise<DiscordDeliveryResult> {
    this.requests.push(request);
    return super.enqueue(request, deliveryFn);
  }
}

function createHandlers(options: {
  plana?: Plana;
  runtimeDriver?: RuntimeDriver;
  taskIdFactory?: () => string;
  accessPolicy?: DiscordAccessPolicy;
  deliveryQueue?: DiscordDeliveryQueue;
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
    ...(options.accessPolicy === undefined
      ? {}
      : { accessPolicy: options.accessPolicy }),
    ...(options.deliveryQueue === undefined
      ? {}
      : { deliveryQueue: options.deliveryQueue }),
  });

  return {
    dispatcher,
    taskRegistry,
    handlers,
  };
}

function expectOwnerAdminDenial(
  content: string,
  taskId: string,
  action: 'cancel' | 'rerun' | 'archive' | 'unarchive',
): void {
  expect(content).toContain(`Task \`${taskId}\` was not changed.`);
  expect(content).toContain(`Requested action: /${action}`);
  expect(content).toContain(
    `Only the task owner or a Discord admin can use \`/${action}\` on this task.`,
  );
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

    // UX-23 (cycle 8): lifecycle now flows through `editReply` so the
    // accept / running / terminal sequence updates a single in-place
    // message. The fake adapter still appends one entry per editReply
    // call (Discord production replaces the visible message); we
    // therefore assert content across every editReply entry, with no
    // followUp expected.
    expect(interaction.editedReplies.length).toBeGreaterThanOrEqual(2);
    const editedContent = interaction.editedReplies.map((p) => p.content);
    expect(editedContent.some((content) => content.includes('Accepted task `discord-task-fixed-task-id`'))).toBe(true);
    expect(editedContent.some((content) => content.includes('is running'))).toBe(true);
    expect(editedContent.some((content) => content.includes('finished with `success`'))).toBe(true);
    expect(interaction.followUpReplies).toHaveLength(0);

    const record = taskRegistry.get('discord-task-fixed-task-id');
    expect(record?.coarseState).toBe('terminal');
    expect(record?.terminalEvidence).toMatchObject({
      reason: 'discord handler completed the task',
      provenance: 'discord-offline-test-driver',
      artifactLocation: 'results/discord-task',
    });
  });

  it('/rerun starts a fresh task from terminal evidence without reusing the old artifact root', async () => {
    const taskIds = ['source-rerun-id', 'fresh-rerun-id'];
    const { handlers, taskRegistry } = createHandlers({
      taskIdFactory: () => taskIds.shift() ?? 'unexpected-rerun-id',
    });

    await handlers.handleInteraction(
      new FakeDiscordInteraction('ask', {
        instruction: 'run baseline experiment',
      }),
    );
    await flushDiscordAsyncWork();

    const source = taskRegistry.get('discord-task-source-rerun-id');
    expect(source?.coarseState).toBe('terminal');
    expect(source?.requestedInstruction).toBe('run baseline experiment');
    expect(source?.instruction).toContain(
      'Artifact root: results/task-artifacts/discord-task-source-rerun-id',
    );

    const rerun = new FakeDiscordInteraction('rerun', {
      task_id: 'discord-task-source-rerun-id',
      note: 'lower learning rate',
    });
    await handlers.handleInteraction(rerun);
    await flushDiscordAsyncWork();

    expect(rerun.editedReplies[0].content).toContain(
      'Rerun accepted for task `discord-task-source-rerun-id` as `discord-task-fresh-rerun-id`',
    );
    const fresh = taskRegistry.get('discord-task-fresh-rerun-id');
    expect(fresh).toMatchObject({
      rerunOfTaskId: 'discord-task-source-rerun-id',
      requestedInstruction: expect.stringContaining('lower learning rate'),
    });
    expect(fresh?.instruction).toContain(
      'Artifact root: results/task-artifacts/discord-task-fresh-rerun-id',
    );
    expect(fresh?.instruction).not.toContain(
      'Artifact root: results/task-artifacts/discord-task-source-rerun-id',
    );
    expect(fresh?.coarseState).toBe('terminal');
  });

  it('/rerun reports unknown source tasks without registering a fresh task', async () => {
    const { handlers, taskRegistry } = createHandlers({});
    const rerun = new FakeDiscordInteraction('rerun', {
      task_id: 'discord-task-unknown-rerun',
      note: 'try again',
    });

    await handlers.handleInteraction(rerun);

    expect(rerun.editedReplies[0].content).toContain(
      'discord-task-unknown-rerun',
    );
    expect(rerun.editedReplies[0].content).toContain('not tracked');
    expect(taskRegistry.list({ state: 'all' })).toEqual([]);
  });

  it('/rerun requires the source task owner or a Discord admin', async () => {
    const taskIds = ['owned-rerun-id', 'admin-rerun-id'];
    const { handlers, taskRegistry } = createHandlers({
      accessPolicy: new DiscordAccessPolicy({
        allowDms: true,
        adminUserIds: ['discord-admin-1'],
      }),
      taskIdFactory: () => taskIds.shift() ?? 'unexpected-rerun-owner-id',
    });

    await handlers.handleInteraction(
      new FakeDiscordInteraction('ask', {
        instruction: 'owned experiment',
      }),
    );
    await flushDiscordAsyncWork();

    const nonOwnerRerun = new FakeDiscordInteraction(
      'rerun',
      { task_id: 'discord-task-owned-rerun-id' },
      'discord-user-2',
    );
    await handlers.handleInteraction(nonOwnerRerun);

    expectOwnerAdminDenial(
      nonOwnerRerun.editedReplies[0].content,
      'discord-task-owned-rerun-id',
      'rerun',
    );
    expect(taskRegistry.get('discord-task-admin-rerun-id')).toBeUndefined();

    const adminRerun = new FakeDiscordInteraction(
      'rerun',
      { task_id: 'discord-task-owned-rerun-id' },
      'discord-admin-1',
    );
    await handlers.handleInteraction(adminRerun);
    await flushDiscordAsyncWork();

    expect(adminRerun.editedReplies[0].content).toContain(
      'Rerun accepted for task `discord-task-owned-rerun-id` as `discord-task-admin-rerun-id`',
    );
    expect(taskRegistry.get('discord-task-admin-rerun-id')).toMatchObject({
      rerunOfTaskId: 'discord-task-owned-rerun-id',
      userId: 'discord-admin-1',
    });
  });

  it('keeps unknown task mutation replies ahead of owner/admin guard', async () => {
    const { handlers } = createHandlers({
      accessPolicy: new DiscordAccessPolicy({ allowDms: true }),
    });
    const commands = ['rerun', 'cancel', 'archive', 'unarchive'] as const;

    for (const commandName of commands) {
      const taskId = `discord-task-unknown-${commandName}`;
      const interaction = new FakeDiscordInteraction(
        commandName,
        { task_id: taskId },
        'discord-user-2',
      );

      await handlers.handleInteraction(interaction);

      expect(interaction.editedReplies[0].content).toContain(taskId);
      expect(interaction.editedReplies[0].content).toContain('not tracked');
      expect(interaction.editedReplies[0].content).not.toContain(
        'Only the task owner or a Discord admin',
      );
    }
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

    // UX-23 (cycle 8): terminal lands via editReply now, so search the
    // edited reply array (single in-place updated message in production).
    const terminalReply = interaction.editedReplies.find((payload) =>
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

  it('/help explains owner/admin task mutations and read-only inspection', async () => {
    const { handlers } = createHandlers({});
    const help = new FakeDiscordInteraction('help', {});

    await handlers.handleInteraction(help);

    // UX-7: /help is reorganized into named sections; the message can
    // span multiple chunks split across the leading editReply + later
    // followUp replies via the message-chunking pipeline, so we join
    // both arrays before asserting on the section headers + commands.
    const helpText = [...help.editedReplies, ...help.followUpReplies]
      .map((r) => r.content)
      .join('\n');
    // Quickstart section.
    expect(helpText).toContain('Quickstart');
    expect(helpText).toContain('Mention the bot');
    expect(helpText).toContain('/status task_id:');
    // Read-only inspection section.
    expect(helpText).toContain('Read-only inspection');
    for (const cmd of ['/tasks', '/history', '/context', '/feed', '/traits']) {
      expect(helpText).toContain(cmd);
    }
    expect(helpText).toContain('view:talk');
    // Owner / admin task changes section.
    expect(helpText).toContain('Owner / admin task changes');
    for (const cmd of ['/cancel', '/rerun', '/archive', '/unarchive', '/escalate']) {
      expect(helpText).toContain(cmd);
    }
    // Long-running research section.
    expect(helpText).toContain('Long-running research');
    for (const cmd of ['/research', '/evidence', '/claim', '/research-plan', '/agenda']) {
      expect(helpText).toContain(cmd);
    }
    // Admin-only ops section.
    expect(helpText).toContain('Admin-only ops');
    expect(helpText).toContain('Discord admin');
    for (const cmd of ['/doctor', '/proof', '/auth', '/approve', '/deny', '/subagents', '/config']) {
      expect(helpText).toContain(cmd);
    }
  });

  it('/archive hides a tracked task from default task lists while preserving inspectability', async () => {
    const { handlers, taskRegistry } = createHandlers({
      taskIdFactory: () => 'archive-task-id',
    });

    await handlers.handleInteraction(
      new FakeDiscordInteraction('ask', {
        instruction: 'finish and archive',
      }),
    );
    await flushDiscordAsyncWork();

    const archiveInteraction = new FakeDiscordInteraction('archive', {
      task_id: 'discord-task-archive-task-id',
      reason: 'superseded by follow-up run',
    });
    await handlers.handleInteraction(archiveInteraction);

    expect(archiveInteraction.editedReplies[0].content).toContain(
      'Archived task `discord-task-archive-task-id`',
    );
    expect(taskRegistry.get('discord-task-archive-task-id')?.archive).toMatchObject({
      archivedBy: 'discord-user-1',
      reason: 'superseded by follow-up run',
    });

    const defaultTasks = new FakeDiscordInteraction('tasks', {});
    await handlers.handleInteraction(defaultTasks);
    expect(defaultTasks.editedReplies[0].content).toContain(
      'No visible Discord tasks',
    );

    const archivedTasks = new FakeDiscordInteraction(
      'tasks',
      { state: 'archived' },
    );
    await handlers.handleInteraction(archivedTasks);
    expect(archivedTasks.editedReplies[0].content).toContain(
      'discord-task-archive-task-id',
    );
    expect(archivedTasks.editedReplies[0].content).toContain('archived');

    const status = new FakeDiscordInteraction('status', {
      task_id: 'discord-task-archive-task-id',
    });
    await handlers.handleInteraction(status);
    expect(status.editedReplies[0].content).toContain('Archive: archived at');

    const archiveAgain = new FakeDiscordInteraction('archive', {
      task_id: 'discord-task-archive-task-id',
    });
    await handlers.handleInteraction(archiveAgain);
    expect(archiveAgain.editedReplies[0].content).toContain('already archived');

    const unarchiveInteraction = new FakeDiscordInteraction('unarchive', {
      task_id: 'discord-task-archive-task-id',
      reason: 'back on comparison board',
    });
    await handlers.handleInteraction(unarchiveInteraction);
    expect(unarchiveInteraction.editedReplies[0].content).toContain(
      'Restored archived task `discord-task-archive-task-id`',
    );
    expect(taskRegistry.get('discord-task-archive-task-id')?.archive).toBeUndefined();

    const restoredDefaultTasks = new FakeDiscordInteraction('tasks', {});
    await handlers.handleInteraction(restoredDefaultTasks);
    expect(restoredDefaultTasks.editedReplies[0].content).toContain(
      'discord-task-archive-task-id',
    );

    const restoredArchivedTasks = new FakeDiscordInteraction(
      'tasks',
      { state: 'archived' },
    );
    await handlers.handleInteraction(restoredArchivedTasks);
    // UX-9: archived view has its own empty wording.
    expect(restoredArchivedTasks.editedReplies[0].content).toContain(
      'No archived Discord tasks',
    );

    const restoredStatus = new FakeDiscordInteraction('status', {
      task_id: 'discord-task-archive-task-id',
    });
    await handlers.handleInteraction(restoredStatus);
    expect(restoredStatus.editedReplies[0].content).not.toContain(
      'Archive: archived at',
    );

    const unarchiveAgain = new FakeDiscordInteraction('unarchive', {
      task_id: 'discord-task-archive-task-id',
    });
    await handlers.handleInteraction(unarchiveAgain);
    expect(unarchiveAgain.editedReplies[0].content).toContain('is not archived');
  });

  it('/archive and /unarchive require the task owner or a Discord admin', async () => {
    const { handlers, taskRegistry } = createHandlers({
      accessPolicy: new DiscordAccessPolicy({
        allowDms: true,
        adminUserIds: ['discord-admin-1'],
      }),
      taskIdFactory: () => 'owned-archive-id',
    });

    await handlers.handleInteraction(
      new FakeDiscordInteraction('ask', {
        instruction: 'finish owned archive task',
      }),
    );
    await flushDiscordAsyncWork();

    const nonOwnerArchive = new FakeDiscordInteraction(
      'archive',
      { task_id: 'discord-task-owned-archive-id' },
      'discord-user-2',
    );
    await handlers.handleInteraction(nonOwnerArchive);
    expectOwnerAdminDenial(
      nonOwnerArchive.editedReplies[0].content,
      'discord-task-owned-archive-id',
      'archive',
    );
    expect(taskRegistry.get('discord-task-owned-archive-id')?.archive).toBeUndefined();

    const ownerArchive = new FakeDiscordInteraction('archive', {
      task_id: 'discord-task-owned-archive-id',
    });
    await handlers.handleInteraction(ownerArchive);
    expect(taskRegistry.get('discord-task-owned-archive-id')?.archive).toBeDefined();

    const nonOwnerUnarchive = new FakeDiscordInteraction(
      'unarchive',
      { task_id: 'discord-task-owned-archive-id' },
      'discord-user-2',
    );
    await handlers.handleInteraction(nonOwnerUnarchive);
    expectOwnerAdminDenial(
      nonOwnerUnarchive.editedReplies[0].content,
      'discord-task-owned-archive-id',
      'unarchive',
    );
    expect(taskRegistry.get('discord-task-owned-archive-id')?.archive).toBeDefined();

    const adminUnarchive = new FakeDiscordInteraction(
      'unarchive',
      { task_id: 'discord-task-owned-archive-id' },
      'discord-admin-1',
    );
    await handlers.handleInteraction(adminUnarchive);
    expect(adminUnarchive.editedReplies[0].content).toContain(
      'Restored archived task `discord-task-owned-archive-id`',
    );
    expect(taskRegistry.get('discord-task-owned-archive-id')?.archive).toBeUndefined();

    const adminArchive = new FakeDiscordInteraction(
      'archive',
      { task_id: 'discord-task-owned-archive-id' },
      'discord-admin-1',
    );
    await handlers.handleInteraction(adminArchive);
    expect(adminArchive.editedReplies[0].content).toContain(
      'Archived task `discord-task-owned-archive-id`',
    );
    expect(taskRegistry.get('discord-task-owned-archive-id')?.archive).toMatchObject({
      archivedBy: 'discord-admin-1',
    });
  });

  it('denies non-owner task mutations when no admin access policy is configured', async () => {
    const deliveryQueue = new RecordingDiscordDeliveryQueue();
    const { handlers, taskRegistry } = createHandlers({
      taskIdFactory: () => 'no-policy-owner-id',
      deliveryQueue,
    });
    const taskId = 'discord-task-no-policy-owner-id';

    await handlers.handleInteraction(
      new FakeDiscordInteraction('ask', {
        instruction: 'finish no policy task',
      }),
    );
    await flushDiscordAsyncWork();

    const mutationCases = [
      { commandName: 'rerun', eventType: 'rerun-reply' },
      { commandName: 'cancel', eventType: 'cancel-ack' },
      { commandName: 'archive', eventType: 'archive-reply' },
      { commandName: 'unarchive', eventType: 'unarchive-reply' },
    ] as const;

    for (const { commandName, eventType } of mutationCases) {
      const beforeRequests = deliveryQueue.requests.length;
      const interaction = new FakeDiscordInteraction(
        commandName,
        { task_id: taskId },
        'discord-user-2',
      );
      await handlers.handleInteraction(interaction);
      const [request] = deliveryQueue.requests.slice(beforeRequests);

      expect(interaction.deferredReplies).toHaveLength(1);
      expectOwnerAdminDenial(
        interaction.editedReplies[0].content,
        taskId,
        commandName,
      );
      expect(request).toBeDefined();
      expect(request?.idempotencyKey).toBe(`${taskId}:${eventType}:0`);
      expect(request?.context).toMatchObject({
        taskId,
        userId: 'discord-user-2',
        eventType,
      });
    }

    const secondRerun = new FakeDiscordInteraction(
      'rerun',
      { task_id: taskId },
      'discord-user-2',
    );
    const beforeSecondRerun = deliveryQueue.requests.length;
    await handlers.handleInteraction(secondRerun);
    const [secondRerunRequest] = deliveryQueue.requests.slice(beforeSecondRerun);

    expect(secondRerun.deferredReplies).toHaveLength(1);
    expectOwnerAdminDenial(secondRerun.editedReplies[0].content, taskId, 'rerun');
    expect(secondRerunRequest?.idempotencyKey).toBe(`${taskId}:rerun-reply:1`);
    expect(taskRegistry.get(taskId)?.archive).toBeUndefined();
    expect(taskRegistry.get(taskId)?.cancellationReceipt).toBeUndefined();
  });

  it('/archive refuses to hide active tasks', async () => {
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
      taskIdFactory: () => 'active-archive-id',
    });

    await handlers.handleInteraction(
      new FakeDiscordInteraction('ask', {
        instruction: 'stay active',
      }),
    );

    const archiveInteraction = new FakeDiscordInteraction('archive', {
      task_id: 'discord-task-active-archive-id',
      reason: 'hide active task',
    });
    await handlers.handleInteraction(archiveInteraction);

    expect(archiveInteraction.editedReplies[0].content).toContain(
      'was not archived',
    );
    expect(archiveInteraction.editedReplies[0].content).toContain(
      'Only terminal tasks can be archived',
    );
    expect(taskRegistry.get('discord-task-active-archive-id')?.archive).toBeUndefined();

    driverExecution.resolve({
      reason: 'late success',
      provenance: 'discord-offline-test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, {
        outcome: 'success',
        reason: 'late success',
        provenance: 'discord-offline-test-driver',
      }),
    });
  });

  it('/rerun refuses active tasks', async () => {
    const driverExecution = createControlledPromise<RuntimeDriverResult>();
    const { handlers } = createHandlers({
      runtimeDriver: {
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'waiting',
          });
          return driverExecution.promise;
        },
      },
      taskIdFactory: () => 'active-rerun-id',
    });

    await handlers.handleInteraction(
      new FakeDiscordInteraction('ask', {
        instruction: 'stay active for rerun guard',
      }),
    );

    const rerunInteraction = new FakeDiscordInteraction('rerun', {
      task_id: 'discord-task-active-rerun-id',
    });
    await handlers.handleInteraction(rerunInteraction);

    expect(rerunInteraction.editedReplies[0].content).toContain(
      'was not rerun',
    );
    expect(rerunInteraction.editedReplies[0].content).toContain(
      'Only terminal tasks can be rerun',
    );

    driverExecution.resolve({
      reason: 'late success',
      provenance: 'discord-offline-test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, {
        outcome: 'success',
        reason: 'late success',
        provenance: 'discord-offline-test-driver',
      }),
    });
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

  it('/cancel requires the active task owner or a Discord admin', async () => {
    const driverExecution = createControlledPromise<RuntimeDriverResult>();
    const { dispatcher, handlers, taskRegistry } = createHandlers({
      accessPolicy: new DiscordAccessPolicy({
        allowDms: true,
        adminUserIds: ['discord-admin-1'],
      }),
      runtimeDriver: {
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'waiting',
          });
          return driverExecution.promise;
        },
      },
      taskIdFactory: () => 'owned-cancel-id',
    });
    const cancelSpy = vi.spyOn(dispatcher, 'cancel');

    await handlers.handleInteraction(
      new FakeDiscordInteraction('ask', {
        instruction: 'wait for owner cancel',
      }),
    );

    const nonOwnerCancel = new FakeDiscordInteraction(
      'cancel',
      {
        task_id: 'discord-task-owned-cancel-id',
        reason: 'stop someone else task',
      },
      'discord-user-2',
    );
    await handlers.handleInteraction(nonOwnerCancel);

    expectOwnerAdminDenial(
      nonOwnerCancel.editedReplies[0].content,
      'discord-task-owned-cancel-id',
      'cancel',
    );
    expect(
      taskRegistry.get('discord-task-owned-cancel-id')?.cancellationReceipt,
    ).toBeUndefined();
    expect(cancelSpy).not.toHaveBeenCalled();

    const adminCancel = new FakeDiscordInteraction(
      'cancel',
      {
        task_id: 'discord-task-owned-cancel-id',
        reason: 'admin stop',
      },
      'discord-admin-1',
    );
    await handlers.handleInteraction(adminCancel);
    await flushDiscordAsyncWork();

    expect(adminCancel.editedReplies[0].content).toContain(
      'Cancellation requested',
    );
    expect(taskRegistry.get('discord-task-owned-cancel-id')?.cancellationReceipt)
      .toMatchObject({
        reason: 'admin stop',
        status: 'accepted',
      });
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    driverExecution.resolve({
      reason: 'late success',
      provenance: 'discord-offline-test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, {
        outcome: 'success',
        reason: 'late success',
        provenance: 'discord-offline-test-driver',
      }),
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
