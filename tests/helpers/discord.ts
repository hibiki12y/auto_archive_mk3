import type {
  DiscordCommandInteractionAdapter,
  DiscordFirstSliceCommandName,
} from '../../src/discord/discord-command-handlers.js';
import type { DiscordMessagePayload } from '../../src/discord/discord-result-renderer.js';

export class FakeDiscordInteraction implements DiscordCommandInteractionAdapter {
  readonly deferredReplies: Array<{ ephemeral?: boolean } | undefined> = [];
  readonly editedReplies: DiscordMessagePayload[] = [];
  readonly followUpReplies: DiscordMessagePayload[] = [];

  constructor(
    readonly commandName: DiscordFirstSliceCommandName,
    private readonly strings: Record<string, string>,
    readonly userId = 'discord-user-1',
    readonly channelId = 'discord-channel-1',
    readonly guildId?: string,
  ) {}

  getString(name: string, required?: boolean): string | null {
    const value = this.strings[name];
    if (value !== undefined) {
      return value;
    }
    if (required) {
      throw new Error(`Missing required option: ${name}`);
    }
    return null;
  }

  async deferReply(options?: { ephemeral?: boolean }): Promise<void> {
    this.deferredReplies.push(options);
  }

  async editReply(payload: DiscordMessagePayload): Promise<void> {
    this.editedReplies.push(payload);
  }

  async followUp(payload: DiscordMessagePayload): Promise<void> {
    this.followUpReplies.push(payload);
  }
}

export async function flushDiscordAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await Promise.resolve();
}
