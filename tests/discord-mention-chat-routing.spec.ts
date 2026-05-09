import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  MentionChatHintState,
  type RuntimeDriverResult,
} from '../src/index.js';
import { withSynthesizedCause } from './helpers/wu-v-cause.js';
import { FakeDiscordInteraction, flushDiscordAsyncWork } from './helpers/discord.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

// UX-26 (cycle 12) — chat-by-default routing for mention-driven
// natural-language messages. The classifier short-circuits the task
// dispatch lifecycle for chat-only / chat-with-task-hint / task-confirm
// classifications. Slash commands always take the task path.

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
  taskIdFactory: () => 'mention-chat-id',
};

class MentionInteraction extends FakeDiscordInteraction {
  override readonly source = 'natural-language' as const;
}

function createHandlersWithChatRouting(): {
  readonly handlers: DiscordCommandHandlers;
  readonly hintState: MentionChatHintState;
  readonly taskRegistry: DiscordTaskRegistry;
} {
  const dispatcher = new Dispatcher(
    new InProcessComputeNode(
      new AgentRuntime({
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'complete',
            detail: 'mention-chat-test',
          });
          return withSynthesizedCause(context, {
            outcome: 'success',
            reason: 'ok',
            provenance: 'mention-chat-test',
            artifactLocation: 'results/discord-task',
          });
        },
      }),
    ),
  );
  const taskRegistry = new DiscordTaskRegistry();
  const hintState = new MentionChatHintState({ ttlMs: 5 * 60 * 1_000 });
  const handlers = new DiscordCommandHandlers({
    arona: new Arona(new Plana(), dispatcher),
    dispatcher,
    taskRegistry,
    requestFactory: new DefaultDiscordTaskRequestFactory(
      defaultRequestFactoryOptions,
    ),
    mentionChatHintState: hintState,
  });
  return { handlers, hintState, taskRegistry };
}

describe('UX-26 — mention chat-by-default routing', () => {
  it('chat-only mention replies with the brief chat hint and does NOT register a task', async () => {
    const { handlers, taskRegistry } = createHandlersWithChatRouting();
    const interaction = new MentionInteraction('ask', {
      instruction: '안녕',
    });
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    expect(interaction.editedReplies.length).toBeGreaterThanOrEqual(1);
    expect(interaction.editedReplies[0].content).toContain('메시지 받았습니다');
    expect(interaction.editedReplies[0].content).toContain('task로 처리하시려면');
    // No task got registered.
    expect(taskRegistry.list({ limit: 50 })).toHaveLength(0);
  });

  it('chat-with-task-hint records a hint with TTL and offers escalation', async () => {
    const { handlers, hintState, taskRegistry } = createHandlersWithChatRouting();
    const interaction = new MentionInteraction(
      'ask',
      {
        instruction: '메르센 소수를 출력',
      },
      'user-7',
      'channel-9',
    );
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    expect(interaction.editedReplies[0].content).toContain('task로 처리하는 게 좋아 보입니다');
    expect(interaction.editedReplies[0].content).toContain('진행');
    // Hint state is populated for (channel, user) pair.
    const hint = hintState.getActiveHint('channel-9', 'user-7');
    expect(hint).toBeDefined();
    expect(hint!.originalInstruction).toBe('메르센 소수를 출력');
    // No task registered yet (the user must confirm).
    expect(taskRegistry.list({ limit: 50 })).toHaveLength(0);
  });

  it('task-confirm after a chat-with-task-hint dispatches the ORIGINAL instruction', async () => {
    const { handlers, hintState, taskRegistry } = createHandlersWithChatRouting();
    const first = new MentionInteraction(
      'ask',
      { instruction: '메르센 소수를 출력' },
      'user-7',
      'channel-9',
    );
    await handlers.handleInteraction(first);
    await flushDiscordAsyncWork();
    expect(hintState.getActiveHint('channel-9', 'user-7')).toBeDefined();

    const confirm = new MentionInteraction(
      'ask',
      { instruction: '진행' },
      'user-7',
      'channel-9',
    );
    await handlers.handleInteraction(confirm);
    await flushDiscordAsyncWork();

    // The hint was consumed.
    expect(hintState.getActiveHint('channel-9', 'user-7')).toBeUndefined();
    // The bot acknowledged the escalation.
    const escalateAck = confirm.editedReplies.find((p) =>
      p.content.includes('Task로 dispatch'),
    );
    expect(escalateAck).toBeDefined();
    // A task was registered with the ORIGINAL instruction (not the
    // bare "진행" confirm word).
    const tasks = taskRegistry.list({ limit: 50 });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks[0].instruction).toContain('메르센 소수를 출력');
  });

  it('task-explicit mention bypasses the chat path and dispatches directly', async () => {
    const { handlers, hintState, taskRegistry } = createHandlersWithChatRouting();
    const interaction = new MentionInteraction(
      'ask',
      { instruction: 'task: build a vm at results/foo' },
      'user-7',
      'channel-9',
    );
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    // No chat hint recorded (task-explicit cleared / never set).
    expect(hintState.getActiveHint('channel-9', 'user-7')).toBeUndefined();
    // Task registered immediately.
    expect(taskRegistry.list({ limit: 50 })).toHaveLength(1);
    // Lifecycle messages on the channel (Accepted / running / terminal).
    const editedContents = interaction.editedReplies.map((p) => p.content);
    expect(
      editedContents.some((c) => c.includes('Accepted task')),
    ).toBe(true);
  });

  it('slash-command source ALWAYS takes the task path even when mentionChatHintState is wired', async () => {
    const { handlers, taskRegistry } = createHandlersWithChatRouting();
    // FakeDiscordInteraction defaults to `source` undefined — handler
    // treats undefined source as not-natural-language and bypasses the
    // chat router. Same for explicit `slash-command` source.
    const interaction = new FakeDiscordInteraction('ask', {
      instruction: '안녕',  // Would be chat-only in mention path.
    });
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    // Slash command always dispatches.
    expect(taskRegistry.list({ limit: 50 })).toHaveLength(1);
  });
});

describe('UX-26 — handlers without mentionChatHintState preserve cycle 1-11 behavior', () => {
  it('mention is dispatched as a task when mentionChatHintState is omitted', async () => {
    const dispatcher = new Dispatcher(
      new InProcessComputeNode(
        new AgentRuntime({
          async run(context): Promise<RuntimeDriverResult> {
            void context.emit({
              kind: 'agent-step',
              step: 'complete',
              detail: 'legacy-test',
            });
            return withSynthesizedCause(context, {
              outcome: 'success',
              reason: 'ok',
              provenance: 'legacy-test',
              artifactLocation: 'results/discord-task',
            });
          },
        }),
      ),
    );
    const taskRegistry = new DiscordTaskRegistry();
    const handlers = new DiscordCommandHandlers({
      arona: new Arona(new Plana(), dispatcher),
      dispatcher,
      taskRegistry,
      requestFactory: new DefaultDiscordTaskRequestFactory(
        defaultRequestFactoryOptions,
      ),
      // mentionChatHintState intentionally omitted.
    });
    const interaction = new MentionInteraction('ask', {
      instruction: '안녕',
    });
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    // Default behavior (cycles 1-11) preserved: every mention →
    // task dispatch even for short greetings.
    expect(taskRegistry.list({ limit: 50 })).toHaveLength(1);
  });
});
