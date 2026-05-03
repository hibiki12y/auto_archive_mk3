import { describe, expect, it } from 'vitest';

import {
  chunkDiscordContentBySentence,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  splitDiscordMessagePayload,
  type DiscordMessagePayload,
} from '../src/index.js';
import { FakeDiscordInteraction } from './helpers/discord.js';

const acceptance = {
  taskId: 'discord-task-1' as never,
  acceptedAt: '2026-04-26T00:00:00.000Z',
  boundary: 'dispatcher' as const,
};

describe('Discord message chunking', () => {
  it('splits long content on natural sentence boundaries when possible', () => {
    const content = '첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.';
    const chunks = chunkDiscordContentBySentence(content, 16);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 16)).toBe(true);
    expect(chunks[0]).toBe('첫 문장입니다.');
    expect(chunks[1]).toBe('둘째 문장입니다.');
  });

  it('hard-splits a single over-limit sentence without truncating it', () => {
    const content = 'x'.repeat(2050);
    const chunks = chunkDiscordContentBySentence(content);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join('')).toBe(content);
  });

  it('expands one payload into multiple Discord-safe payloads', () => {
    const payload: DiscordMessagePayload = {
      content: `${'A sentence.'.repeat(220)} Final sentence.`,
    };
    const chunks = splitDiscordMessagePayload(payload, 200);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 200)).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes('…'))).toBe(false);
  });

  it('delivers chunked command output as one edit followed by follow-ups', async () => {
    const taskRegistry = new DiscordTaskRegistry();
    for (let index = 0; index < 50; index += 1) {
      taskRegistry.registerTask({
        taskId: `discord-task-${index.toString().padStart(2, '0')}`,
        instruction: 'x'.repeat(80),
        userId: 'user-1',
        channelId: 'chan-1',
        acceptance,
      });
    }
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
    });
    const interaction = new FakeDiscordInteraction(
      'tasks',
      { limit: '50' },
      'user-1',
      'chan-1',
    );

    await handlers.handleInteraction(interaction);

    expect(interaction.editedReplies).toHaveLength(1);
    expect(interaction.followUpReplies.length).toBeGreaterThan(0);
    expect(
      [...interaction.editedReplies, ...interaction.followUpReplies].every(
        (reply) => reply.content.length <= 2000,
      ),
    ).toBe(true);
  });
});
