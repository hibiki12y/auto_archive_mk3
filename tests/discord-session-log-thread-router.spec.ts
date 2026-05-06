import { describe, expect, it } from 'vitest';

import {
  DefaultDiscordSessionLogThreadRouter,
  buildThreadName,
  type DiscordSessionLogParentChannelHandle,
  type DiscordSessionLogParentChannelResolver,
  type DiscordSessionLogThreadHandle,
} from '../src/discord/discord-session-log-thread-router.js';

class FakeThread implements DiscordSessionLogThreadHandle {
  public readonly sentPayloads: Array<{ content: string }> = [];

  constructor(public readonly id: string) {}

  send(payload: { content: string }): Promise<unknown> {
    this.sentPayloads.push(payload);
    return Promise.resolve({ ok: true, threadId: this.id });
  }
}

class FakeParentChannel implements DiscordSessionLogParentChannelHandle {
  public readonly id = 'parent-1';
  public readonly created: Array<{
    name: string;
    autoArchiveDurationMinutes: number | undefined;
    threadId: string;
  }> = [];
  public readonly threadsByTaskName = new Map<string, FakeThread>();
  private nextThreadIndex = 1;
  public createShouldThrow: Error | undefined;

  threads = {
    create: async (input: {
      name: string;
      autoArchiveDurationMinutes?: number;
    }): Promise<DiscordSessionLogThreadHandle> => {
      if (this.createShouldThrow !== undefined) {
        throw this.createShouldThrow;
      }
      const threadId = `thread-${this.nextThreadIndex++}`;
      this.created.push({
        name: input.name,
        autoArchiveDurationMinutes: input.autoArchiveDurationMinutes,
        threadId,
      });
      const thread = new FakeThread(threadId);
      this.threadsByTaskName.set(input.name, thread);
      return thread;
    },
  };
}

class FakeResolver implements DiscordSessionLogParentChannelResolver {
  public resolveCount = 0;
  public resolveShouldThrow: Error | undefined;

  constructor(private readonly channel: FakeParentChannel) {}

  resolveParentChannel(
    parentChannelId: string,
  ): Promise<DiscordSessionLogParentChannelHandle> {
    this.resolveCount += 1;
    if (this.resolveShouldThrow !== undefined) {
      return Promise.reject(this.resolveShouldThrow);
    }
    if (parentChannelId !== this.channel.id) {
      return Promise.reject(
        new Error(`unexpected parentChannelId: ${parentChannelId}`),
      );
    }
    return Promise.resolve(this.channel);
  }
}

describe('DefaultDiscordSessionLogThreadRouter', () => {
  it('lazily creates a thread on the first followUp and reuses it on subsequent calls', async () => {
    const channel = new FakeParentChannel();
    const resolver = new FakeResolver(channel);
    const router = new DefaultDiscordSessionLogThreadRouter({
      parentChannelId: channel.id,
      resolver,
    });

    const first = await router.routeFollowUp({
      taskId: 'discord-task-abc123',
      payload: { content: 'first running update' },
      eventType: 'running-update',
    });
    expect(first.delivered).toBe('thread');
    expect(first.threadId).toBe('thread-1');
    expect(channel.created).toHaveLength(1);
    expect(channel.created[0]?.name).toBe('Task discord-task-abc123');
    const firstThread = channel.threadsByTaskName.get('Task discord-task-abc123');
    expect(firstThread?.sentPayloads.map((p) => p.content)).toEqual([
      'first running update',
    ]);

    const second = await router.routeFollowUp({
      taskId: 'discord-task-abc123',
      payload: { content: 'terminal result' },
      eventType: 'terminal-result',
    });
    expect(second.delivered).toBe('thread');
    expect(second.threadId).toBe('thread-1');
    expect(channel.created).toHaveLength(1);
    expect(resolver.resolveCount).toBe(1);
    expect(firstThread?.sentPayloads.map((p) => p.content)).toEqual([
      'first running update',
      'terminal result',
    ]);
  });

  it('keeps a separate thread per Task ID', async () => {
    const channel = new FakeParentChannel();
    const router = new DefaultDiscordSessionLogThreadRouter({
      parentChannelId: channel.id,
      resolver: new FakeResolver(channel),
    });

    const a = await router.routeFollowUp({
      taskId: 'task-a',
      payload: { content: 'a-1' },
    });
    const b = await router.routeFollowUp({
      taskId: 'task-b',
      payload: { content: 'b-1' },
    });
    expect(a.threadId).toBe('thread-1');
    expect(b.threadId).toBe('thread-2');
    expect(channel.created.map((c) => c.name)).toEqual([
      'Task task-a',
      'Task task-b',
    ]);
  });

  it('returns channel-fallback when thread creation throws and clears the cache so a retry can succeed', async () => {
    const channel = new FakeParentChannel();
    const router = new DefaultDiscordSessionLogThreadRouter({
      parentChannelId: channel.id,
      resolver: new FakeResolver(channel),
    });

    channel.createShouldThrow = new Error('thread permission denied');
    const fallback = await router.routeFollowUp({
      taskId: 'task-x',
      payload: { content: 'first attempt' },
    });
    expect(fallback.delivered).toBe('channel-fallback');
    expect(fallback.fallbackReason).toContain('thread-create-failed');
    expect(fallback.fallbackReason).toContain('thread permission denied');

    channel.createShouldThrow = undefined;
    const retry = await router.routeFollowUp({
      taskId: 'task-x',
      payload: { content: 'retry' },
    });
    expect(retry.delivered).toBe('thread');
    expect(retry.threadId).toBe('thread-1');
  });

  it('returns channel-fallback when thread.send fails on a cached thread', async () => {
    const channel = new FakeParentChannel();
    const router = new DefaultDiscordSessionLogThreadRouter({
      parentChannelId: channel.id,
      resolver: new FakeResolver(channel),
    });
    await router.routeFollowUp({
      taskId: 'task-y',
      payload: { content: 'starter' },
    });

    const sentinel = new Error('thread archived');
    const cachedThread = (
      router as unknown as {
        threadByTaskId: Map<string, Promise<DiscordSessionLogThreadHandle>>;
      }
    ).threadByTaskId.get('task-y');
    expect(cachedThread).toBeDefined();
    const handle = await cachedThread!;
    (handle as FakeThread).send = () => Promise.reject(sentinel);

    const fallback = await router.routeFollowUp({
      taskId: 'task-y',
      payload: { content: 'second' },
    });
    expect(fallback.delivered).toBe('channel-fallback');
    expect(fallback.fallbackReason).toContain('thread-send-failed');
    expect(fallback.fallbackReason).toContain('thread archived');
  });

  it('refuses an empty first message and surfaces the reason', async () => {
    const channel = new FakeParentChannel();
    const router = new DefaultDiscordSessionLogThreadRouter({
      parentChannelId: channel.id,
      resolver: new FakeResolver(channel),
    });

    const result = await router.routeFollowUp({
      taskId: 'task-z',
      payload: { content: '' },
    });
    expect(result.delivered).toBe('channel-fallback');
    expect(result.fallbackReason).toContain('thread-create-failed');
    expect(result.fallbackReason).toContain(
      'Thread first message cannot be empty',
    );
  });

  it('rejects construction with an empty parent channel id', () => {
    expect(
      () =>
        new DefaultDiscordSessionLogThreadRouter({
          parentChannelId: '',
          resolver: new FakeResolver(new FakeParentChannel()),
        }),
    ).toThrow(/non-empty parentChannelId/);
  });

  it('caps thread names to the Discord 100-character limit', () => {
    const veryLong = 'X'.repeat(150);
    const built = buildThreadName(veryLong, 'Task ');
    expect(built.length).toBe(100);
    expect(built.startsWith('Task XXX')).toBe(true);
  });

  it('invokes the optional onError sink with the underlying error', async () => {
    const channel = new FakeParentChannel();
    channel.createShouldThrow = new Error('thread 403');
    const errors: Array<{ error: unknown; taskId: string }> = [];
    const router = new DefaultDiscordSessionLogThreadRouter({
      parentChannelId: channel.id,
      resolver: new FakeResolver(channel),
      onError: (error, ctx) => {
        errors.push({ error, taskId: ctx.taskId });
      },
    });

    await router.routeFollowUp({
      taskId: 'task-watch',
      payload: { content: 'go' },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.taskId).toBe('task-watch');
    expect((errors[0]?.error as Error).message).toBe('thread 403');
  });

  it('forwards autoArchiveDurationMinutes when configured', async () => {
    const channel = new FakeParentChannel();
    const router = new DefaultDiscordSessionLogThreadRouter({
      parentChannelId: channel.id,
      resolver: new FakeResolver(channel),
      autoArchiveDurationMinutes: 60,
    });
    await router.routeFollowUp({
      taskId: 'task-archive',
      payload: { content: 'hi' },
    });
    expect(channel.created[0]?.autoArchiveDurationMinutes).toBe(60);
  });
});
