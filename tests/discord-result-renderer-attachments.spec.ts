import { describe, expect, it } from 'vitest';

import {
  splitDiscordMessagePayload,
  type DiscordAttachment,
  type DiscordMessagePayload,
} from '../src/index.js';

describe('DiscordMessagePayload attachments + splitter (P3-def-2)', () => {
  const fakeAttachment: DiscordAttachment = {
    name: 'plan-abc.md',
    path: '/tmp/research-plan-reports/plan-abc.md',
  };

  it('passes a payload with an attachment through splitDiscordMessagePayload unchanged when content fits in one chunk', () => {
    const payload: DiscordMessagePayload = {
      content: 'short message that fits in a single chunk.',
      allowedMentions: { parse: [] },
      attachments: [fakeAttachment],
    };

    const chunks = splitDiscordMessagePayload(payload, 200);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(payload.content);
    expect(chunks[0]?.attachments).toEqual([fakeAttachment]);
    expect(chunks[0]?.allowedMentions?.parse).toEqual([]);
  });

  it('attaches files only to the FIRST fragment when content is split into multiple chunks', () => {
    // Force a hard split: content > limit, no sentence boundaries inside the
    // first segment so the splitter has to chunk it.
    const longContent =
      `${'A sentence.'.repeat(60)} Another sentence. ` +
      `${'B sentence.'.repeat(60)} Tail sentence.`;
    const payload: DiscordMessagePayload = {
      content: longContent,
      allowedMentions: { parse: [] },
      attachments: [fakeAttachment],
    };

    const chunks = splitDiscordMessagePayload(payload, 200);

    expect(chunks.length).toBeGreaterThan(1);
    // First chunk carries the attachment.
    expect(chunks[0]?.attachments).toEqual([fakeAttachment]);
    // Subsequent chunks carry no attachment field (Discord forbids re-uploading
    // the same file on each chunked follow-up).
    for (const chunk of chunks.slice(1)) {
      expect(chunk.attachments).toBeUndefined();
    }
    // allowedMentions still rides every chunk (existing behaviour).
    expect(chunks.every((chunk) => chunk.allowedMentions?.parse.length === 0)).toBe(
      true,
    );
    // Joining content should still preserve text.
    expect(chunks.map((c) => c.content).join('').length).toBeGreaterThan(0);
  });

  it('preserves prior splitDiscordMessagePayload behaviour when no attachments are present (regression guard)', () => {
    const payload: DiscordMessagePayload = {
      content: `${'A sentence.'.repeat(220)} Final sentence.`,
      allowedMentions: { parse: [] },
    };

    const chunks = splitDiscordMessagePayload(payload, 200);

    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should sprout an attachments field.
    expect(chunks.every((chunk) => chunk.attachments === undefined)).toBe(true);
    expect(chunks.every((chunk) => chunk.content.length <= 200)).toBe(true);
    expect(chunks.every((chunk) => chunk.allowedMentions?.parse.length === 0)).toBe(
      true,
    );
  });
});
