import { describe, expect, it } from 'vitest';
import { AttachmentBuilder } from 'discord.js';

import {
  toDiscordJsPayload,
  type DiscordAttachment,
  type DiscordMessagePayload,
} from '../src/index.js';

describe('toDiscordJsPayload (P3-def-2 production adapter helper)', () => {
  it('passes content + allowedMentions through and omits files when no attachments are present', () => {
    const payload: DiscordMessagePayload = {
      content: 'hello world',
      allowedMentions: { parse: [] },
    };

    const wire = toDiscordJsPayload(payload);

    expect(wire['content']).toBe('hello world');
    expect(wire['allowedMentions']).toEqual({ parse: [] });
    // No attachments => no `files` key on the wire payload (so discord.js
    // sees the legacy shape and does not attempt an upload step).
    expect('files' in wire).toBe(false);
  });

  it('maps payload.attachments to discord.js AttachmentBuilder instances under the files key', () => {
    const attachment: DiscordAttachment = {
      name: 'plan-foo.md',
      path: '/tmp/research-plan-reports/plan-foo.md',
    };
    const payload: DiscordMessagePayload = {
      content: 'see attached',
      attachments: [attachment],
    };

    const wire = toDiscordJsPayload(payload);

    expect(wire['content']).toBe('see attached');
    const files = wire['files'];
    expect(Array.isArray(files)).toBe(true);
    const fileArray = files as unknown[];
    expect(fileArray).toHaveLength(1);
    const first = fileArray[0];
    expect(first).toBeInstanceOf(AttachmentBuilder);
    // AttachmentBuilder exposes the configured filename via `.name`. We
    // assert on the public-shaped surface to keep the test resilient if
    // discord.js changes its internal storage.
    const builder = first as AttachmentBuilder;
    expect(builder.name).toBe('plan-foo.md');
  });
});
