import { describe, expect, it, vi } from 'vitest';

import {
  adaptResearchWorkflowButtonInteraction,
  adaptSubagentButtonInteraction,
} from '../src/discord/discord-bot.js';
import {
  renderResearchCloseoutChecklist,
  renderResearchMissionSummary,
  type DiscordMessagePayload,
} from '../src/discord/discord-result-renderer.js';
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

function collectCustomIds(payload: DiscordMessagePayload): string[] {
  return (
    payload.components?.flatMap((row) =>
      row.components.map((component) => component.customId),
    ) ?? []
  );
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

describe('adaptResearchWorkflowButtonInteraction', () => {
  it('returns undefined outside known research button namespaces', () => {
    const { interaction } = makeFakeButtonInteraction('subagents:kill:subagent-1');
    expect(adaptResearchWorkflowButtonInteraction(interaction)).toBeUndefined();
  });

  it('returns undefined for malformed or unsupported research button ids', () => {
    expect(
      adaptResearchWorkflowButtonInteraction(
        makeFakeButtonInteraction('research-mission:status').interaction,
      ),
    ).toBeUndefined();
    expect(
      adaptResearchWorkflowButtonInteraction(
        makeFakeButtonInteraction('research-closeout:cancel:').interaction,
      ),
    ).toBeUndefined();
    expect(
      adaptResearchWorkflowButtonInteraction(
        makeFakeButtonInteraction('research-mission:delete:R-1').interaction,
      ),
    ).toBeUndefined();
  });

  it('routes research mission status/show-plan/cancel buttons to mission show or status', () => {
    const status = adaptResearchWorkflowButtonInteraction(
      makeFakeButtonInteraction('research-mission:status:R-20260510-a1').interaction,
    );
    expect(status).toBeDefined();
    expect(status!.commandName).toBe('research');
    expect(status!.source).toBe('slash-command');
    expect(status!.getString('action')).toBe('status');
    expect(status!.getString('mission_id')).toBe('R-20260510-a1');

    const showPlan = adaptResearchWorkflowButtonInteraction(
      makeFakeButtonInteraction('research-mission:show-plan:R-20260510-a1').interaction,
    );
    expect(showPlan).toBeDefined();
    expect(showPlan!.commandName).toBe('research');
    expect(showPlan!.source).toBe('slash-command');
    expect(showPlan!.getString('action')).toBe('show');
    expect(showPlan!.getString('mission_id')).toBe('R-20260510-a1');

    const cancel = adaptResearchWorkflowButtonInteraction(
      makeFakeButtonInteraction('research-mission:cancel:R-20260510-a1').interaction,
    );
    expect(cancel).toBeDefined();
    expect(cancel!.commandName).toBe('research');
    expect(cancel!.getString('action')).toBe('show');
  });

  it('routes research mission action buttons through existing slash handlers', () => {
    const approve = adaptResearchWorkflowButtonInteraction(
      makeFakeButtonInteraction('research-mission:approve:R-20260510-a1').interaction,
    );
    expect(approve).toBeDefined();
    expect(approve!.commandName).toBe('research');
    expect(approve!.getString('action')).toBe('approve');
    expect(approve!.getString('mission_id')).toBe('R-20260510-a1');
    expect(approve!.getString('plan_id')).toBeNull();

    const synthesize = adaptResearchWorkflowButtonInteraction(
      makeFakeButtonInteraction('research-mission:synthesize:R-20260510-a1').interaction,
    );
    expect(synthesize).toBeDefined();
    expect(synthesize!.commandName).toBe('research');
    expect(synthesize!.getString('action')).toBe('synthesize');

    const archive = adaptResearchWorkflowButtonInteraction(
      makeFakeButtonInteraction('research-mission:archive:R-20260510-a1').interaction,
    );
    expect(archive).toBeDefined();
    expect(archive!.commandName).toBe('research');
    expect(archive!.getString('action')).toBe('archive');
  });

  it('routes evidence and critique mission buttons to their specialized commands', () => {
    const evidence = adaptResearchWorkflowButtonInteraction(
      makeFakeButtonInteraction('research-mission:show-evidence:R-20260510-a1')
        .interaction,
    );
    expect(evidence).toBeDefined();
    expect(evidence!.commandName).toBe('evidence');
    expect(evidence!.getString('action')).toBe('list');
    expect(evidence!.getString('mission_id')).toBe('R-20260510-a1');

    const critique = adaptResearchWorkflowButtonInteraction(
      makeFakeButtonInteraction('research-mission:run-critique:R-20260510-a1')
        .interaction,
    );
    expect(critique).toBeDefined();
    expect(critique!.commandName).toBe('critique');
    expect(critique!.getString('lens')).toBe('counterargument');
    expect(critique!.getString('mission_id')).toBe('R-20260510-a1');
  });

  it('routes closeout buttons without introducing archive or proof mutations', () => {
    const archiveAnyway = adaptResearchWorkflowButtonInteraction(
      makeFakeButtonInteraction('research-closeout:archive-anyway:R-20260510-a1')
        .interaction,
    );
    expect(archiveAnyway).toBeDefined();
    expect(archiveAnyway!.commandName).toBe('research');
    expect(archiveAnyway!.source).toBe('slash-command');
    expect(archiveAnyway!.getString('action')).toBe('archive');
    expect(archiveAnyway!.getString('mission_id')).toBe('R-20260510-a1');

    const proof = adaptResearchWorkflowButtonInteraction(
      makeFakeButtonInteraction('research-closeout:run-missing-proof:R-20260510-a1')
        .interaction,
    );
    expect(proof).toBeDefined();
    expect(proof!.commandName).toBe('proof');
    expect(proof!.getString('action')).toBe('capture');
    expect(proof!.getString('mission_id')).toBe('R-20260510-a1');
    expect(proof!.getString('surface')).toBeNull();

    const cancel = adaptResearchWorkflowButtonInteraction(
      makeFakeButtonInteraction('research-closeout:cancel:R-20260510-a1').interaction,
    );
    expect(cancel).toBeDefined();
    expect(cancel!.commandName).toBe('research');
    expect(cancel!.getString('action')).toBe('show');
  });

  it('routes deferReply / editReply / followUp through the research button adapter', async () => {
    const { interaction, deferReply, editReply, followUp } =
      makeFakeButtonInteraction('research-mission:archive:R-20260510-a1');
    const adapter = adaptResearchWorkflowButtonInteraction(interaction);
    await adapter!.deferReply({ ephemeral: true });
    await adapter!.editReply({ content: 'archive preflight' });
    await adapter!.followUp({ content: 'done' });
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledTimes(1);

    const {
      interaction: closeoutInteraction,
      deferReply: closeoutDeferReply,
      editReply: closeoutEditReply,
      followUp: closeoutFollowUp,
    } = makeFakeButtonInteraction(
      'research-closeout:run-missing-proof:R-20260510-a1',
    );
    const closeoutAdapter =
      adaptResearchWorkflowButtonInteraction(closeoutInteraction);
    await closeoutAdapter!.deferReply({ ephemeral: true });
    await closeoutAdapter!.editReply({ content: 'capture preflight' });
    await closeoutAdapter!.followUp({ content: 'done' });
    expect(closeoutDeferReply).toHaveBeenCalledTimes(1);
    expect(closeoutEditReply).toHaveBeenCalledTimes(1);
    expect(closeoutFollowUp).toHaveBeenCalledTimes(1);
  });

  it('keeps every rendered mission and closeout button wired to an adapter route', () => {
    const missionPayload = renderResearchMissionSummary({
      missionId: 'R-20260510-a1',
      title: 'Button adapter inventory',
      status: 'running',
      phase: 'evidence synthesis',
      owner: '@operator',
      threadLabel: 'research-runs / R-20260510-a1',
      plan: [{ label: 'Collect evidence', state: 'current' }],
      evidenceCount: 1,
      claims: { supported: 1, uncertain: 0, challenged: 0 },
      proof: { pass: 0, warn: 1 },
      nextActions: [
        { verb: 'status', label: 'Status' },
        { verb: 'synthesize', label: 'Synthesize' },
        { verb: 'show-evidence', label: 'Show evidence' },
        { verb: 'run-critique', label: 'Run critique' },
        { verb: 'archive', label: 'Archive' },
      ],
    });
    const closeoutPayload = renderResearchCloseoutChecklist({
      missionId: 'R-20260510-a1',
      required: [{ text: 'synthesis report exists', state: 'complete' }],
      actions: [
        { verb: 'archive-anyway', label: 'Archive anyway' },
        { verb: 'run-missing-proof', label: 'Run missing proof' },
        { verb: 'cancel', label: 'Cancel' },
      ],
    });

    const customIds = [
      ...collectCustomIds(missionPayload),
      ...collectCustomIds(closeoutPayload),
    ];
    expect(customIds).toEqual([
      'research-mission:status:R-20260510-a1',
      'research-mission:synthesize:R-20260510-a1',
      'research-mission:show-evidence:R-20260510-a1',
      'research-mission:run-critique:R-20260510-a1',
      'research-mission:archive:R-20260510-a1',
      'research-closeout:archive-anyway:R-20260510-a1',
      'research-closeout:run-missing-proof:R-20260510-a1',
      'research-closeout:cancel:R-20260510-a1',
    ]);
    for (const customId of customIds) {
      const adapter = adaptResearchWorkflowButtonInteraction(
        makeFakeButtonInteraction(customId).interaction,
      );
      expect(adapter, customId).toBeDefined();
    }
  });
});
