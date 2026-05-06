import { describe, expect, it } from 'vitest';

import {
  DiscordCommandHandlers,
  DiscordTaskRegistry,
} from '../src/index.js';
import type {
  DiscordSessionLogForumRouteInput,
  DiscordSessionLogForumRouteOutcome,
  DiscordSessionLogForumRouter,
} from '../src/discord/discord-session-log-forum-router.js';
import { FakeDiscordInteraction } from './helpers/discord.js';

const acceptance = {
  taskId: 'discord-task-1' as never,
  acceptedAt: '2026-04-26T00:00:00.000Z',
  boundary: 'dispatcher' as const,
};

class RecordingForumRouter implements DiscordSessionLogForumRouter {
  public readonly calls: DiscordSessionLogForumRouteInput[] = [];

  constructor(
    private readonly outcomeFor: (
      input: DiscordSessionLogForumRouteInput,
    ) => DiscordSessionLogForumRouteOutcome = (input) => ({
      delivered: 'thread',
      threadId: `thread-for-${input.taskId}`,
    }),
  ) {}

  async routeFollowUp(
    input: DiscordSessionLogForumRouteInput,
  ): Promise<DiscordSessionLogForumRouteOutcome> {
    this.calls.push(input);
    return this.outcomeFor(input);
  }
}

describe('DiscordCommandHandlers session-log forum routing', () => {
  it('routes chunked followUps through the session-log forum router instead of the source channel', async () => {
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
    const router = new RecordingForumRouter();
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
      sessionLogForumRouter: router,
    });
    const interaction = new FakeDiscordInteraction(
      'tasks',
      { limit: '50' },
      'user-1',
      'chan-1',
    );

    await handlers.handleInteraction(interaction);

    expect(interaction.editedReplies.length).toBe(1);
    expect(interaction.followUpReplies.length).toBe(0);
    expect(router.calls.length).toBeGreaterThan(0);
    expect(
      router.calls.every((call) => call.taskId === 'discord-tasks-user-1'),
    ).toBe(true);
    expect(router.calls.every((call) => call.eventType === 'tasks-reply')).toBe(
      true,
    );
  });

  it('falls back to interaction.followUp when the router reports channel-fallback', async () => {
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
    const router = new RecordingForumRouter(() => ({
      delivered: 'channel-fallback',
      fallbackReason: 'thread-create-failed:permission-denied',
    }));
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
      sessionLogForumRouter: router,
    });
    const interaction = new FakeDiscordInteraction(
      'tasks',
      { limit: '50' },
      'user-1',
      'chan-1',
    );

    await handlers.handleInteraction(interaction);

    expect(interaction.editedReplies.length).toBe(1);
    expect(interaction.followUpReplies.length).toBeGreaterThan(0);
    expect(router.calls.length).toBe(interaction.followUpReplies.length);
  });

  it('does not call the router when no router is configured', async () => {
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

    expect(interaction.editedReplies.length).toBe(1);
    expect(interaction.followUpReplies.length).toBeGreaterThan(0);
  });
});
