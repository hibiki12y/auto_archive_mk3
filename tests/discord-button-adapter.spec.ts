import { describe, expect, it, vi } from 'vitest';

import { adaptSubagentButtonInteraction } from '../src/discord/discord-bot.js';
import type { ButtonInteraction } from 'discord.js';

// UX-14 (cycle 7) — `/subagents` button-press adapter. The bot's
// InteractionCreate listener funnels button presses through this
// adapter; the resulting `DiscordCommandInteractionAdapter` flows
// through the existing `handleSubagents` path (no new branch).

function makeFakeButtonInteraction(
  customId: string,
  overrides: Partial<{
    userId: string;
    channelId: string | null;
    guildId: string | null;
  }> = {},
): {
  readonly interaction: ButtonInteraction;
  readonly deferReply: ReturnType<typeof vi.fn>;
  readonly editReply: ReturnType<typeof vi.fn>;
  readonly followUp: ReturnType<typeof vi.fn>;
} {
  const deferReply = vi.fn().mockReturnValue(Promise.resolve({}));
  const editReply = vi.fn().mockReturnValue(Promise.resolve({}));
  const followUp = vi.fn().mockReturnValue(Promise.resolve({}));
  const interaction = {
    customId,
    user: { id: overrides.userId ?? 'user-77' },
    channelId:
      overrides.channelId === undefined ? 'channel-7' : overrides.channelId,
    guildId: overrides.guildId === undefined ? 'guild-7' : overrides.guildId,
    deferReply,
    editReply,
    followUp,
  } as unknown as ButtonInteraction;
  return { interaction, deferReply, editReply, followUp };
}

describe('adaptSubagentButtonInteraction', () => {
  it('returns undefined when the customId is outside the subagents namespace', () => {
    const { interaction } = makeFakeButtonInteraction('other:do:thing');
    expect(adaptSubagentButtonInteraction(interaction)).toBeUndefined();
  });

  it('returns undefined when the customId is malformed (wrong segment count)', () => {
    const { interaction } = makeFakeButtonInteraction('subagents:kill');
    expect(adaptSubagentButtonInteraction(interaction)).toBeUndefined();
    const { interaction: extra } = makeFakeButtonInteraction(
      'subagents:kill:foo:extra',
    );
    expect(adaptSubagentButtonInteraction(extra)).toBeUndefined();
  });

  it('returns undefined when the verb is not kill or log', () => {
    const { interaction } = makeFakeButtonInteraction(
      'subagents:bogus:subagent-1',
    );
    expect(adaptSubagentButtonInteraction(interaction)).toBeUndefined();
  });

  it('returns undefined when the subagentId segment is empty', () => {
    const { interaction } = makeFakeButtonInteraction('subagents:kill:');
    expect(adaptSubagentButtonInteraction(interaction)).toBeUndefined();
  });

  it('synthesizes a slash-shaped adapter for kill (action+target options)', () => {
    const { interaction } = makeFakeButtonInteraction(
      'subagents:kill:subagent-9',
      { userId: 'op-1' },
    );
    const adapter = adaptSubagentButtonInteraction(interaction);
    expect(adapter).toBeDefined();
    expect(adapter!.commandName).toBe('subagents');
    expect(adapter!.userId).toBe('op-1');
    expect(adapter!.source).toBe('slash-command');
    expect(adapter!.getString('action')).toBe('kill');
    expect(adapter!.getString('target')).toBe('subagent-9');
    expect(adapter!.getString('text')).toBeNull();
  });

  it('synthesizes a slash-shaped adapter for log', () => {
    const { interaction } = makeFakeButtonInteraction(
      'subagents:log:subagent-3',
    );
    const adapter = adaptSubagentButtonInteraction(interaction);
    expect(adapter).toBeDefined();
    expect(adapter!.getString('action')).toBe('log');
    expect(adapter!.getString('target')).toBe('subagent-3');
  });

  it('routes deferReply / editReply / followUp back to the underlying button interaction', async () => {
    const { interaction, deferReply, editReply, followUp } =
      makeFakeButtonInteraction('subagents:kill:subagent-2');
    const adapter = adaptSubagentButtonInteraction(interaction);
    await adapter!.deferReply({ ephemeral: true });
    await adapter!.editReply({ content: 'killed' });
    await adapter!.followUp({ content: 'done' });
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledTimes(1);
    // ephemeral flag should map through to discord.js MessageFlags.Ephemeral.
    const deferArg = deferReply.mock.calls[0]![0];
    expect(deferArg).toBeDefined();
    expect(typeof (deferArg as { flags?: number }).flags).toBe('number');
  });
});
