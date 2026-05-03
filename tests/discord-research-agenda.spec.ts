import { describe, expect, it } from 'vitest';

import { DiscordResearchAgenda, InMemoryControlPlaneLedger } from '../src/index.js';

describe('Discord research agenda', () => {
  it('persists agenda items and cadence through the control ledger', () => {
    let tick = 0;
    const now = (): string =>
      `2026-04-26T00:00:0${(tick += 1).toString()}.000Z`;
    const ledger = new InMemoryControlPlaneLedger();
    const firstAgenda = new DiscordResearchAgenda({
      ledger,
      idFactory: () => 'abc123',
      now,
    });

    const item = firstAgenda.addItem({
      title: 'Compare OpenClaw natural-language session reuse',
      userId: 'user-1',
      channelId: 'chan-1',
    });
    const cadence = firstAgenda.setCadence({
      cadence: 'daily operator review after terminal research tasks',
      userId: 'user-1',
      conversationId: 'chan-1',
      channelId: 'chan-1',
    });
    firstAgenda.completeItem({
      agendaId: item.agendaId,
      userId: 'user-1',
      channelId: 'chan-1',
    });

    const replayed = new DiscordResearchAgenda({ ledger });

    expect(replayed.list({ channelId: 'chan-1', status: 'done' })).toEqual([
      expect.objectContaining({
        agendaId: 'research-agenda-abc123',
        title: 'Compare OpenClaw natural-language session reuse',
        status: 'done',
      }),
    ]);
    expect(replayed.getCadence('chan-1')).toEqual(cadence);
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.')),
    ).toEqual([
      'research.agenda_item_added',
      'research.cadence_set',
      'research.agenda_item_completed',
    ]);
  });
});
