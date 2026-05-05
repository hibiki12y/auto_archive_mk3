import { describe, expect, it } from 'vitest';

import {
  chunkDiscordContentBySentence,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  InMemoryTraitUsageTelemetry,
  splitDiscordMessagePayload,
  traitModuleRegistryKey,
  type DiscordMessagePayload,
  type TraitModuleManifest,
  type TraitModuleRegistry,
} from '../src/index.js';
import { FakeDiscordInteraction } from './helpers/discord.js';

const acceptance = {
  taskId: 'discord-task-1' as never,
  acceptedAt: '2026-04-26T00:00:00.000Z',
  boundary: 'dispatcher' as const,
};

function createChunkingTraitModuleRegistry(count: number): TraitModuleRegistry {
  const entries = Array.from({ length: count }, (_, index) => {
    const padded = index.toString().padStart(2, '0');
    const manifest: TraitModuleManifest = {
      schemaVersion: 1,
      id: `trait.chunking.${padded}.v1`,
      name: `chunking trait ${padded} ${'x'.repeat(40)}`,
      version: '1.0.0',
      trustBoundary: 'repository-owned',
      layout: {
        root: `traits/chunking-${padded}`,
        manifest: 'trait.json',
        instruction: 'TRAIT.md',
      },
      instructions: {
        entrypoint: 'TRAIT.md',
        format: 'markdown',
        summary: `chunking trait summary ${padded} ${'y'.repeat(80)}`,
      },
      schedule: { mode: 'none' },
      runtime: { hook: 'none' },
      admission: {
        defaultRequested: false,
        requiredCapabilityFlags: [],
        forbiddenCapabilityFlags: [],
        provenance: 'chunking-test',
      },
      sourceMapIds: [`source-${padded}`],
    };
    const registryKey = traitModuleRegistryKey(manifest);
    return {
      manifest,
      manifestPath: `traits/chunking-${padded}/trait.json`,
      rootPath: `traits/chunking-${padded}`,
      instructionPath: `traits/chunking-${padded}/TRAIT.md`,
      registryKey,
    };
  });
  return {
    entries,
    byRegistryKey: new Map(entries.map((entry) => [entry.registryKey, entry])),
    byId: new Map(entries.map((entry) => [entry.manifest.id, [entry]])),
  };
}

describe('Discord message chunking', () => {
  it('splits long content on natural sentence boundaries when possible', () => {
    const content = '첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.';
    const chunks = chunkDiscordContentBySentence(content, 16);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 16)).toBe(true);
    expect(chunks[0]).toBe('첫 문장입니다.');
    expect(chunks[1]).toBe('둘째 문장입니다.');
  });

  it('hard-splits a single over-limit sentence without truncating it', () => {
    const content = 'x'.repeat(2050);
    const chunks = chunkDiscordContentBySentence(content);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join('')).toBe(content);
  });

  it('expands one payload into multiple Discord-safe payloads', () => {
    const payload: DiscordMessagePayload = {
      content: `${'A sentence.'.repeat(220)} Final sentence.`,
      allowedMentions: { parse: [] },
    };
    const chunks = splitDiscordMessagePayload(payload, 200);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 200)).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes('…'))).toBe(false);
    expect(chunks.every((chunk) => chunk.allowedMentions?.parse.length === 0)).toBe(
      true,
    );
  });

  it('delivers chunked command output as one edit followed by follow-ups', async () => {
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

    expect(interaction.editedReplies).toHaveLength(1);
    expect(interaction.followUpReplies.length).toBeGreaterThan(0);
    expect(
      [...interaction.editedReplies, ...interaction.followUpReplies].every(
        (reply) => reply.content.length <= 2000,
      ),
    ).toBe(true);
  });

  it('chunks usage-augmented /traits output without enabling mentions', async () => {
    const traitModuleRegistry = createChunkingTraitModuleRegistry(40);
    const traitUsageTelemetry = new InMemoryTraitUsageTelemetry();
    for (const entry of traitModuleRegistry.entries) {
      traitUsageTelemetry.bumpUse(
        {
          taskId: `discord-task-${entry.registryKey}-@everyone\``,
          bumpedTraitModuleId: entry.manifest.id,
        },
        { observedAt: '2026-05-05T00:00:01.000Z@everyone`' },
      );
    }
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      traitModuleRegistry,
      traitUsageTelemetry,
    });
    const interaction = new FakeDiscordInteraction('traits', {}, 'user-1', 'chan-1');

    await handlers.handleInteraction(interaction);

    const replies = [...interaction.editedReplies, ...interaction.followUpReplies];
    expect(interaction.editedReplies).toHaveLength(1);
    expect(interaction.followUpReplies.length).toBeGreaterThan(0);
    expect(replies.every((reply) => reply.content.length <= 2000)).toBe(true);
    expect(
      replies.every((reply) => reply.allowedMentions?.parse.length === 0),
    ).toBe(true);
    expect(replies.map((reply) => reply.content).join('\n')).not.toContain(
      '@everyone',
    );
  });
});
