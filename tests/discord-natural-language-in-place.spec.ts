import { describe, expect, it, vi } from 'vitest';

import { adaptNaturalLanguageMessage } from '../src/discord/discord-bot.js';
import type { Message } from 'discord.js';

// UX-23 / UX-24 (cycle 10) — natural-language (mention) adapter must
// edit the same message in place across the lifecycle so the channel
// shows ONE message per task instead of N. Pre-fix the adapter mapped
// editReply + followUp both to message.reply, which always created a
// new Discord message.

function makeFakeMentionMessage(content: string): {
  readonly message: Message;
  readonly replyCalls: unknown[];
  readonly editCalls: unknown[];
  setReplyShouldThrow: (next: boolean) => void;
} {
  const replyCalls: unknown[] = [];
  const editCalls: unknown[] = [];
  let replyShouldThrow = false;
  const repliedMessage = {
    edit: vi.fn().mockImplementation((payload: unknown) => {
      editCalls.push(payload);
      return Promise.resolve({});
    }),
    startThread: vi.fn().mockResolvedValue({
      id: 'thread-1',
      send: vi.fn().mockResolvedValue({}),
    }),
  };
  const message = {
    id: 'msg-source-1',
    content,
    createdTimestamp: 1730000000000,
    author: { id: 'user-99', bot: false },
    guildId: 'guild-1',
    channelId: 'channel-1',
    reply: vi.fn().mockImplementation((payload: unknown) => {
      if (replyShouldThrow) {
        throw new Error('reply rejected');
      }
      replyCalls.push(payload);
      return Promise.resolve(repliedMessage);
    }),
  } as unknown as Message;
  return {
    message,
    replyCalls,
    editCalls,
    setReplyShouldThrow: (next) => {
      replyShouldThrow = next;
    },
  };
}

describe('UX-23 / UX-24 (cycle 10) — natural-language adapter in-place edit + thread handle', () => {
  it('first editReply uses message.reply (creates the in-place anchor)', async () => {
    const { message, replyCalls, editCalls } = makeFakeMentionMessage(
      '<@bot> compute',
    );
    const adapter = adaptNaturalLanguageMessage(message, 'bot');
    expect(adapter).toBeDefined();
    await adapter!.editReply({ content: 'Accepted task' });
    expect(replyCalls).toHaveLength(1);
    expect(editCalls).toHaveLength(0);
  });

  it('subsequent editReply / followUp calls edit the SAME message (in-place)', async () => {
    const { message, replyCalls, editCalls } = makeFakeMentionMessage(
      '<@bot> compute',
    );
    const adapter = adaptNaturalLanguageMessage(message, 'bot');
    await adapter!.editReply({ content: 'Accepted task' });
    await adapter!.followUp({ content: 'Task is running' });
    await adapter!.editReply({ content: 'Task finished with success' });
    // Only ONE reply call (the initial anchor); two subsequent calls
    // edit that same message in place.
    expect(replyCalls).toHaveLength(1);
    expect(editCalls).toHaveLength(2);
    expect((editCalls[1] as { content: string }).content).toContain(
      'finished with success',
    );
  });

  it('fetchReply returns a thread-capable handle once the anchor has landed', async () => {
    const { message } = makeFakeMentionMessage('<@bot> compute');
    const adapter = adaptNaturalLanguageMessage(message, 'bot');
    // Before any editReply, the cache is empty → fetchReply is undefined.
    const beforeAnchor = await adapter!.fetchReply!();
    expect(beforeAnchor).toBeUndefined();
    await adapter!.editReply({ content: 'Accepted task' });
    const afterAnchor = await adapter!.fetchReply!();
    expect(afterAnchor).toBeDefined();
    // The handle exposes startThread (UX-24 thread auto-create).
    expect(typeof afterAnchor!.startThread).toBe('function');
  });

  it('falls open to a fresh reply when the in-place edit throws (network 4xx etc.)', async () => {
    const { message, replyCalls, editCalls } = makeFakeMentionMessage(
      '<@bot> compute',
    );
    const adapter = adaptNaturalLanguageMessage(message, 'bot');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await adapter!.editReply({ content: 'Accepted task' });
      // Force the cached message.edit to throw.
      const repliedMessageHandle = (
        message.reply as unknown as ReturnType<typeof vi.fn>
      ).mock.results[0]?.value as Promise<{ edit: ReturnType<typeof vi.fn> }>;
      const handle = await repliedMessageHandle;
      handle.edit.mockRejectedValueOnce(new Error('discord 5xx'));
      await adapter!.editReply({ content: 'Task running' });
    } finally {
      warn.mockRestore();
    }
    // Reply happened twice: the initial anchor + the fallback after the
    // edit failure (mockRejectedValueOnce skips the underlying push).
    expect(replyCalls.length).toBe(2);
    expect(editCalls.length).toBe(0);
  });
});
