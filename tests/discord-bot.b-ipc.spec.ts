import { afterEach, describe, expect, it, vi } from 'vitest';
import { Events, type Client as DiscordClient } from 'discord.js';

import {
  BoundaryValidationError,
  adaptChatInputInteraction,
  startDiscordFirstSliceBot,
} from '../src/index.js';

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
  taskIdFactory: () => 'bot-test-id',
};

class FakeDiscordClient {
  private readonly listeners = new Map<string, Array<(value: unknown) => unknown>>();

  readonly login = vi.fn(async () => 'logged-in');
  readonly destroy = vi.fn();

  on(event: string, listener: (value: unknown) => unknown): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  async emit(event: string, value: unknown): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) {
      await listener(value);
    }
  }
}

describe('discord bot B-IPC boundary validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects malformed chat-input ingress before creating an adapter', () => {
    expect(() =>
      adaptChatInputInteraction({
        commandName: 'ask',
        user: {},
        channelId: 'discord-channel-1',
        options: {
          getString: vi.fn(),
        },
        deferReply: vi.fn(),
        editReply: vi.fn(),
        followUp: vi.fn(),
      } as never),
    ).toThrow(BoundaryValidationError);

    expect(() =>
      adaptChatInputInteraction({
        commandName: 'ask',
        user: { id: 'discord-user-1' },
        channelId: 42,
        options: {
          getString: vi.fn(),
        },
        deferReply: vi.fn(),
        editReply: vi.fn(),
        followUp: vi.fn(),
      } as never),
    ).toThrow('[B-IPC] interaction.channelId must be a string.');

    expect(() =>
      adaptChatInputInteraction({
        commandName: 'ask',
        user: { id: 'discord-user-1' },
        channelId: 'discord-channel-1',
        options: {},
        deferReply: vi.fn(),
        editReply: vi.fn(),
        followUp: vi.fn(),
      } as never),
    ).toThrow('[B-IPC] interaction.options.getString must be a function.');
  });

  it('fails closed at the adapter boundary before handing malformed ingress to handlers', async () => {
    const client = new FakeDiscordClient();
    const bot = await startDiscordFirstSliceBot({
      token: 'discord-token',
      applicationId: 'app-id',
      arona: {} as never,
      dispatcher: {} as never,
      requestFactoryOptions: defaultRequestFactoryOptions,
      client: client as unknown as DiscordClient,
      registerCommandsOnStart: false,
    });
    const handleSpy = vi.spyOn(bot.handlers, 'handleInteraction');

    await expect(
      client.emit(Events.InteractionCreate, {
        commandName: 'ask',
        user: {},
        channelId: 'discord-channel-1',
        options: {
          getString: vi.fn(),
        },
        deferReply: vi.fn(),
        editReply: vi.fn(),
        followUp: vi.fn(),
        isChatInputCommand: () => true,
      }),
    ).rejects.toThrow('[B-IPC] interaction.user.id must be a string.');
    expect(handleSpy).not.toHaveBeenCalled();

    await bot.stop();
  });
});
