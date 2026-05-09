import { describe, expect, it } from 'vitest';

import {
  buildSubagentActionRows,
  renderSubagentOperatorResult,
  SUBAGENTS_LIST_BUTTON_ROW_LIMIT,
} from '../src/discord/discord-result-renderer.js';
import type { SubagentDescriptor } from '../src/contracts/subagent-roster.js';

// UX-14 (cycle 7) — interactive Kill/Log button rows for `/subagents
// list` replies. Renderer-side coverage; the production button-press
// adapter sits in `discord-bot.ts` and is exercised via the dedicated
// adapter test file.

function makeDescriptor(subagentId: string): SubagentDescriptor {
  return {
    subagentId,
    role: 'explorer',
    parent: { taskId: 'task-1', instanceId: 'instance-1' },
    createdAt: '2026-05-09T00:00:00.000Z',
    state: 'active',
    envelope: Object.freeze({
      capabilities: Object.freeze({}),
      compute: Object.freeze({}),
    }) as unknown as SubagentDescriptor['envelope'],
  };
}

describe('buildSubagentActionRows', () => {
  it('returns undefined for empty / undefined descriptor lists (nothing to attach)', () => {
    expect(buildSubagentActionRows(undefined)).toBeUndefined();
    expect(buildSubagentActionRows([])).toBeUndefined();
  });

  it('emits one row per descriptor with [Kill] [Log] buttons in danger / secondary styles', () => {
    const rows = buildSubagentActionRows([
      makeDescriptor('subagent-1'),
      makeDescriptor('subagent-2'),
    ]);
    expect(rows).toBeDefined();
    expect(rows!.length).toBe(2);
    for (const row of rows!) {
      expect(row.kind).toBe('action-row');
      expect(row.components.length).toBe(2);
      const [kill, log] = row.components;
      expect(kill!.kind).toBe('button');
      expect(kill!.style).toBe('danger');
      expect(kill!.customId.startsWith('subagents:kill:')).toBe(true);
      expect(log!.style).toBe('secondary');
      expect(log!.customId.startsWith('subagents:log:')).toBe(true);
    }
  });

  it(`caps row count at ${SUBAGENTS_LIST_BUTTON_ROW_LIMIT} (Discord max action-row limit)`, () => {
    const descriptors = Array.from({ length: 8 }, (_, index) =>
      makeDescriptor(`subagent-${index}`),
    );
    const rows = buildSubagentActionRows(descriptors);
    expect(rows).toBeDefined();
    expect(rows!.length).toBe(SUBAGENTS_LIST_BUTTON_ROW_LIMIT);
    // The first N descriptors get buttons, in order.
    expect(rows![0].components[0]!.customId).toBe('subagents:kill:subagent-0');
    expect(
      rows![SUBAGENTS_LIST_BUTTON_ROW_LIMIT - 1]!.components[0]!.customId,
    ).toBe(`subagents:kill:subagent-${SUBAGENTS_LIST_BUTTON_ROW_LIMIT - 1}`);
  });
});

describe('renderSubagentOperatorResult attaches button rows for ok-list shape', () => {
  it('attaches one row per descriptor on a non-empty ok list', () => {
    const payload = renderSubagentOperatorResult({
      status: 'ok',
      message: 'subagent-1 explorer active parent=task-1/instance-1',
      descriptors: [makeDescriptor('subagent-1')],
    });
    expect(payload.components).toBeDefined();
    expect(payload.components!.length).toBe(1);
    expect(payload.components![0]!.components[0]!.customId).toBe(
      'subagents:kill:subagent-1',
    );
  });

  it('omits components for an ok-list reply with no descriptors (legacy "no subagents" shape)', () => {
    const payload = renderSubagentOperatorResult({
      status: 'ok',
      message: 'No active subagent dispatches.',
    });
    expect(payload.components).toBeUndefined();
  });

  it('appends a row-cap hint when descriptor count exceeds the row limit', () => {
    const descriptors = Array.from({ length: 8 }, (_, index) =>
      makeDescriptor(`subagent-${index}`),
    );
    const payload = renderSubagentOperatorResult({
      status: 'ok',
      message: descriptors.map((d) => d.subagentId).join('\n'),
      descriptors,
    });
    expect(payload.components!.length).toBe(SUBAGENTS_LIST_BUTTON_ROW_LIMIT);
    expect(payload.content).toContain(
      `Showing buttons for the first ${SUBAGENTS_LIST_BUTTON_ROW_LIMIT} of ${descriptors.length}`,
    );
    expect(payload.content).toContain('/subagents kill <id>');
  });

  it('omits components for denied / not-found shapes (no descriptors to act on)', () => {
    const denied = renderSubagentOperatorResult({
      status: 'denied',
      reason: 'subagent is not in an active dispatch state',
    });
    const notFound = renderSubagentOperatorResult({
      status: 'not-found',
      reason: 'Unknown subagent: subagent-7',
    });
    expect(denied.components).toBeUndefined();
    expect(notFound.components).toBeUndefined();
  });
});
