import { describe, expect, it, vi } from 'vitest';

import {
  DiscordCommandHandlers,
  DiscordTaskRegistry,
} from '../../src/index.js';
import type { PersonaStyleTransformer } from '../../src/persona/persona-style-transformer.js';
import { FakeDiscordInteraction } from '../helpers/discord.js';

const acceptance = {
  taskId: 'discord-task-persona' as never,
  acceptedAt: '2026-04-30T00:00:00.000Z',
  boundary: 'dispatcher' as const,
};

function makeRecordingTransformer(): {
  readonly transformer: PersonaStyleTransformer;
  readonly calls: Array<{
    text: string;
    eventType: string;
    taskId?: string;
  }>;
} {
  const calls: Array<{ text: string; eventType: string; taskId?: string }> = [];
  const transformer: PersonaStyleTransformer = {
    async transform(input) {
      calls.push({ text: input.text, eventType: input.eventType, taskId: input.taskId });
      return `**아로나:** 안내드릴게요. (${input.eventType})\n\n${input.text}\n\n**플라나:** 변경된 응답.`;
    },
  };
  return { transformer, calls };
}

describe('persona — Discord delivery integration', () => {
  it('rewrites a conversational status reply through the transformer (status-reply)', async () => {
    const taskRegistry = new DiscordTaskRegistry();
    const { transformer, calls } = makeRecordingTransformer();
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
      personaTransformer: transformer,
    });
    const interaction = new FakeDiscordInteraction(
      'status',
      { task_id: 'unknown-task-foo' },
      'user-1',
      'chan-1',
    );

    await handlers.handleInteraction(interaction);

    expect(calls).toHaveLength(1);
    expect(calls[0].eventType).toBe('status-reply');
    expect(calls[0].taskId).toBe('unknown-task-foo');
    expect(calls[0].text).toContain('unknown-task-foo');
    expect(interaction.editedReplies).toHaveLength(1);
    expect(interaction.editedReplies[0].content).toContain('**아로나:**');
    expect(interaction.editedReplies[0].content).toContain('**플라나:**');
  });

  it('bypasses the transformer for structured listings (tasks-reply)', async () => {
    const taskRegistry = new DiscordTaskRegistry();
    taskRegistry.registerTask({
      taskId: 'discord-task-01',
      instruction: 'hello world',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance,
    });
    const transform = vi.fn();
    const transformer: PersonaStyleTransformer = {
      transform,
    };
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
      personaTransformer: transformer,
    });
    const interaction = new FakeDiscordInteraction(
      'tasks',
      { limit: '10' },
      'user-1',
      'chan-1',
    );

    await handlers.handleInteraction(interaction);

    expect(transform).not.toHaveBeenCalled();
    expect(interaction.editedReplies).toHaveLength(1);
    expect(interaction.editedReplies[0].content).toContain('discord-task-01');
  });

  it('hard-bypasses structured listings even when transformer eventTypes opt into them', async () => {
    const taskRegistry = new DiscordTaskRegistry();
    taskRegistry.registerTask({
      taskId: 'discord-task-hard-bypass',
      instruction: 'hello world',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance,
    });
    const transform = vi.fn(async () => '**아로나:** should not run\n\n**플라나:** blocked.');
    const transformer: PersonaStyleTransformer = {
      eventTypes: new Set(['tasks-reply' as never]),
      transform,
    };
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
      personaTransformer: transformer,
    });
    const interaction = new FakeDiscordInteraction(
      'tasks',
      { limit: '10' },
      'user-1',
      'chan-1',
    );

    await handlers.handleInteraction(interaction);

    expect(transform).not.toHaveBeenCalled();
    expect(interaction.editedReplies[0].content).toContain('discord-task-hard-bypass');
  });

  it('falls back to original payload when the transformer throws (fail-open)', async () => {
    const taskRegistry = new DiscordTaskRegistry();
    const transformer: PersonaStyleTransformer = {
      async transform() {
        throw new Error('persona-down');
      },
    };
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
      personaTransformer: transformer,
    });
    const interaction = new FakeDiscordInteraction(
      'status',
      { task_id: 'unknown-task-bar' },
      'user-1',
      'chan-1',
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await handlers.handleInteraction(interaction);
    } finally {
      warn.mockRestore();
    }

    expect(interaction.editedReplies).toHaveLength(1);
    expect(interaction.editedReplies[0].content).toContain('unknown-task-bar');
    // Original "is not tracked" copy should survive the fail-open path.
    expect(interaction.editedReplies[0].content).toContain('not tracked');
  });

  it('falls back to original payload when the transformer returns empty', async () => {
    const taskRegistry = new DiscordTaskRegistry();
    const transformer: PersonaStyleTransformer = {
      async transform() {
        return '';
      },
    };
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
      personaTransformer: transformer,
    });
    const interaction = new FakeDiscordInteraction(
      'status',
      { task_id: 'unknown-task-baz' },
      'user-1',
      'chan-1',
    );

    await handlers.handleInteraction(interaction);

    expect(interaction.editedReplies).toHaveLength(1);
    expect(interaction.editedReplies[0].content).toContain('unknown-task-baz');
    expect(interaction.editedReplies[0].content).toContain('not tracked');
  });

  it('falls back to original payload when a rewrite drops protected identifiers', async () => {
    const taskRegistry = new DiscordTaskRegistry();
    const transformer: PersonaStyleTransformer = {
      async transform() {
        return '**아로나:** 추적할 수 없는 작업이에요.';
      },
    };
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
      personaTransformer: transformer,
    });
    const interaction = new FakeDiscordInteraction(
      'status',
      { task_id: 'unknown-task-guard' },
      'user-1',
      'chan-1',
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await handlers.handleInteraction(interaction);
      expect(warn).toHaveBeenCalledWith(
        'discord-persona-transform-invariant-miss',
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
    }

    expect(interaction.editedReplies).toHaveLength(1);
    expect(interaction.editedReplies[0].content).toContain('unknown-task-guard');
    expect(interaction.editedReplies[0].content).toContain('not tracked');
  });

  it('falls back to original payload when a rewrite violates the duet shape', async () => {
    const taskRegistry = new DiscordTaskRegistry();
    const transformer: PersonaStyleTransformer = {
      async transform() {
        return '**아로나:** Task `unknown-task-shape` is not tracked.';
      },
    };
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
      personaTransformer: transformer,
    });
    const interaction = new FakeDiscordInteraction(
      'status',
      { task_id: 'unknown-task-shape' },
      'user-1',
      'chan-1',
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await handlers.handleInteraction(interaction);
      expect(warn).toHaveBeenCalledWith(
        'discord-persona-transform-shape-miss',
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
    }

    expect(interaction.editedReplies).toHaveLength(1);
    expect(interaction.editedReplies[0].content).toContain('unknown-task-shape');
    expect(interaction.editedReplies[0].content).toContain('not tracked');
  });

  it('runs the transformer once on the full payload before chunking', async () => {
    const taskRegistry = new DiscordTaskRegistry();
    const transform = vi.fn(
      async (input: { text: string; eventType: string; taskId?: string }) =>
        // emit a long but already-transformed string
        `**아로나:** ${'A'.repeat(2050)}|${input.eventType}|\n${input.text}\n\n**플라나:** 상태 유지.`,
    );
    const transformer: PersonaStyleTransformer = { transform };
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
      personaTransformer: transformer,
    });
    const interaction = new FakeDiscordInteraction(
      'status',
      { task_id: 'unknown-chunked' },
      'user-1',
      'chan-1',
    );

    await handlers.handleInteraction(interaction);

    expect(transform).toHaveBeenCalledTimes(1);
    expect(interaction.editedReplies.length).toBe(1);
    // > 2000 char output triggers chunking after transform.
    expect(interaction.followUpReplies.length).toBeGreaterThan(0);
    const combined =
      interaction.editedReplies[0].content +
      interaction.followUpReplies.map((r) => r.content).join('');
    expect(combined).toContain('|status-reply');
  });
});
