import { describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  buildTaskThreadName,
  type RuntimeDriverResult,
  type DiscordCommandInteractionAdapter,
  type DiscordMessagePayload,
  type DiscordTaskMessageHandle,
  type DiscordTaskThreadHandle,
} from '../src/index.js';
import { withSynthesizedCause } from './helpers/wu-v-cause.js';
import { FakeDiscordInteraction, flushDiscordAsyncWork } from './helpers/discord.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

// UX-24 (cycle 9) — per-task auto thread. The handler opens a thread
// off the bot's accept message in the source channel; lifecycle and
// terminal payloads also `thread.send(...)`-ed so the thread carries
// a Discord-native progressive history. Failure is fail-open
// (channel-only delivery still works).

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
  taskIdFactory: () => 'thread-test-id',
};

class FakeThreadInteraction
  extends FakeDiscordInteraction
  implements DiscordCommandInteractionAdapter
{
  public readonly threadSends: DiscordMessagePayload[] = [];
  public threadCreated = false;
  public startThreadShouldThrow = false;
  public messageHandleShouldBeNull = false;

  fetchReply = async (): Promise<DiscordTaskMessageHandle | null> => {
    if (this.messageHandleShouldBeNull) {
      return null;
    }
    return {
      startThread: async (): Promise<DiscordTaskThreadHandle> => {
        if (this.startThreadShouldThrow) {
          throw new Error('Missing Permissions');
        }
        this.threadCreated = true;
        return {
          id: 'thread-1',
          send: async (payload) => {
            this.threadSends.push(payload);
            return undefined;
          },
        };
      },
    };
  };
}

function createHandlers(): {
  readonly handlers: DiscordCommandHandlers;
} {
  const dispatcher = new Dispatcher(
    new InProcessComputeNode(
      new AgentRuntime({
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'complete',
            detail: 'thread-test',
          });
          return withSynthesizedCause(context, {
            outcome: 'success',
            reason: '2147483647',
            provenance: 'thread-test-driver',
            artifactLocation: 'results/discord-task',
          });
        },
      }),
    ),
  );
  const handlers = new DiscordCommandHandlers({
    arona: new Arona(new Plana(), dispatcher),
    dispatcher,
    taskRegistry: new DiscordTaskRegistry(),
    requestFactory: new DefaultDiscordTaskRequestFactory(
      defaultRequestFactoryOptions,
    ),
  });
  return { handlers };
}

describe('UX-24 — per-task auto thread', () => {
  it('opens a thread off the accept message and mirrors lifecycle + terminal into it', async () => {
    const { handlers } = createHandlers();
    const interaction = new FakeThreadInteraction('ask', {
      instruction: '2^32 미만의 가장 큰 메르센 소수',
    });
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    expect(interaction.threadCreated).toBe(true);
    // The thread receives at least 2 messages: the accepted payload +
    // the terminal payload (running-update is also forwarded if the
    // lifecycle observed it). The exact count depends on observer
    // timing; assert the must-have payloads via content search.
    expect(interaction.threadSends.length).toBeGreaterThanOrEqual(2);
    const threadContents = interaction.threadSends.map((p) => p.content);
    expect(threadContents.some((c) => c.includes('Accepted task'))).toBe(true);
    expect(threadContents.some((c) => c.includes('finished with `success`'))).toBe(true);
    // Channel still receives the in-place editReply sequence (cycle 8).
    expect(interaction.editedReplies.length).toBeGreaterThanOrEqual(2);
  });

  it('falls open to channel-only when startThread throws (Missing Permissions etc.)', async () => {
    const { handlers } = createHandlers();
    const interaction = new FakeThreadInteraction('ask', {
      instruction: 'compute',
    });
    interaction.startThreadShouldThrow = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await handlers.handleInteraction(interaction);
      await flushDiscordAsyncWork();
    } finally {
      warn.mockRestore();
    }

    expect(interaction.threadCreated).toBe(false);
    expect(interaction.threadSends).toHaveLength(0);
    // Channel editReply sequence is unaffected — terminal still lands.
    const editedContent = interaction.editedReplies.map((p) => p.content);
    expect(editedContent.some((c) => c.includes('finished with `success`'))).toBe(true);
    void warn;
  });

  it('falls open to channel-only when fetchReply returns null (e.g. ephemeral reply)', async () => {
    const { handlers } = createHandlers();
    const interaction = new FakeThreadInteraction('ask', {
      instruction: 'compute',
    });
    interaction.messageHandleShouldBeNull = true;

    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    expect(interaction.threadCreated).toBe(false);
    expect(interaction.threadSends).toHaveLength(0);
    expect(
      interaction.editedReplies.some((p) =>
        p.content.includes('finished with `success`'),
      ),
    ).toBe(true);
  });

  it('skips thread creation entirely when the adapter does not implement fetchReply (legacy adapters)', async () => {
    const { handlers } = createHandlers();
    // Legacy FakeDiscordInteraction does not define `fetchReply`.
    const interaction = new FakeDiscordInteraction('ask', {
      instruction: 'compute',
    });

    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    // No thread, no error, channel-only.
    expect(
      interaction.editedReplies.some((p) =>
        p.content.includes('finished with `success`'),
      ),
    ).toBe(true);
  });
});

describe('wrapDiscordMessageAsTaskHandle', () => {
  it('returns undefined for null / undefined / non-message inputs', async () => {
    const { wrapDiscordMessageAsTaskHandle } = await import(
      '../src/discord/discord-bot.js'
    );
    expect(wrapDiscordMessageAsTaskHandle(null)).toBeUndefined();
    expect(wrapDiscordMessageAsTaskHandle(undefined)).toBeUndefined();
    expect(wrapDiscordMessageAsTaskHandle({})).toBeUndefined();
    // An object that has startThread but as a non-function is also rejected.
    expect(
      wrapDiscordMessageAsTaskHandle({ startThread: 'oops' as unknown }),
    ).toBeUndefined();
  });

  it('wraps a discord.js-shaped message and forwards startThread / send through', async () => {
    const { wrapDiscordMessageAsTaskHandle } = await import(
      '../src/discord/discord-bot.js'
    );
    const sentToThread: unknown[] = [];
    const fakeMessage = {
      startThread: vi.fn().mockResolvedValue({
        id: 'thread-99',
        send: vi.fn().mockImplementation((payload: unknown) => {
          sentToThread.push(payload);
          return Promise.resolve({});
        }),
      }),
    };
    const handle = wrapDiscordMessageAsTaskHandle(fakeMessage);
    expect(handle).toBeDefined();
    const thread = await handle!.startThread({
      name: 'task-thread',
      autoArchiveDurationMinutes: 60,
    });
    expect(thread.id).toBe('thread-99');
    // discord.js startThread receives `autoArchiveDuration` (minutes).
    expect(fakeMessage.startThread).toHaveBeenCalledWith({
      name: 'task-thread',
      autoArchiveDuration: 60,
    });
    await thread.send({ content: 'hi' });
    expect(sentToThread).toHaveLength(1);
  });

  it('defaults autoArchiveDuration to 1440 (24h) when the caller does not specify', async () => {
    const { wrapDiscordMessageAsTaskHandle } = await import(
      '../src/discord/discord-bot.js'
    );
    const fakeMessage = {
      startThread: vi.fn().mockResolvedValue({ id: 't', send: () => Promise.resolve() }),
    };
    const handle = wrapDiscordMessageAsTaskHandle(fakeMessage);
    await handle!.startThread({ name: 'task-thread' });
    expect(fakeMessage.startThread).toHaveBeenCalledWith({
      name: 'task-thread',
      autoArchiveDuration: 1_440,
    });
  });
});

describe('buildTaskThreadName', () => {
  it('joins commandName + taskId under the 100-char Discord cap', () => {
    expect(buildTaskThreadName('discord-task-abc', 'ask')).toBe(
      'ask: discord-task-abc',
    );
  });

  it('truncates names that would exceed the 100-char Discord cap', () => {
    const longTaskId = 'discord-task-' + 'x'.repeat(150);
    const name = buildTaskThreadName(longTaskId, 'research');
    expect(name.length).toBe(100);
    expect(name.startsWith('research: discord-task-')).toBe(true);
  });
});
