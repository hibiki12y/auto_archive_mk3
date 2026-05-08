/**
 * Tests for `/config set` reply enrichment (P2-B / Risk 3 from the
 * comprehensive audit). Provider hot-swap is dispatch-boundary only — a
 * change via `/config set persona:* key:provider` only takes effect on the
 * NEXT dispatch and never preempts an in-flight one. The reply must say so
 * explicitly and surface the previous provider for "did anything change?"
 * confirmation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  Arona,
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  Dispatcher,
  Plana,
  type RuntimeDriverResult,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { FakeDiscordInteraction } from './helpers/discord.js';

const factoryOptions = {
  resources: {
    requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
  },
  runtimeSettings: {
    networkProfile: 'provider-only' as const,
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'on-request' as const,
    workingDirectory: 'results/task-artifacts',
  },
  artifactLocation: 'results/task-artifacts',
};

let workspaces: string[] = [];

afterEach(() => {
  for (const ws of workspaces) {
    rmSync(ws, { recursive: true, force: true });
  }
  workspaces = [];
});

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'discord-config-handler-'));
  workspaces.push(ws);
  return ws;
}

function createHandlers(personaSettingsPath: string): DiscordCommandHandlers {
  const dispatcher = new Dispatcher(
    new InProcessComputeNode(
      new AgentRuntime({
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'complete',
            detail: 'offline',
          } as never);
          return {
            cause: {
              kind: 'success',
              taskId: context.instance.taskId,
              runtimeInstanceId: context.instance.instanceId,
              observedAt: '2026-05-07T00:00:00.000Z',
              provenance: 'offline',
            },
            provenance: 'offline',
            reason: 'ok',
          };
        },
      }),
    ),
  );
  return new DiscordCommandHandlers({
    arona: new Arona(new Plana(), dispatcher),
    dispatcher,
    taskRegistry: new DiscordTaskRegistry(),
    requestFactory: new DefaultDiscordTaskRequestFactory({
      ...factoryOptions,
      taskIdFactory: () => 'fixed',
    }),
    personaSettingsPath,
  });
}

function replyText(interaction: FakeDiscordInteraction): string {
  const last = interaction.editedReplies[interaction.editedReplies.length - 1];
  return last?.content ?? JSON.stringify(last);
}

describe('handleConfig — /config set reply enrichment (P2-B)', () => {
  let storePath: string;

  beforeEach(() => {
    const ws = makeWorkspace();
    storePath = join(ws, 'persona-settings.json');
  });

  it('arona provider change names the next-dispatch provider and shows the previous value', async () => {
    const handlers = createHandlers(storePath);

    // Seed a prior provider override so we can assert the "was: <previous>"
    // line is wired through.
    const seed = new FakeDiscordInteraction('config', {
      action: 'set',
      persona: 'arona',
      key: 'provider',
      value: 'codex',
    });
    await handlers.handleInteraction(seed);
    expect(replyText(seed)).toContain('Saved `arona.provider` = `codex`');

    // Now flip to claude-agent. The reply should:
    //   - confirm the new value,
    //   - name the next-dispatch active provider,
    //   - report the prior value (codex),
    //   - warn that in-flight dispatches keep their current provider.
    const flip = new FakeDiscordInteraction('config', {
      action: 'set',
      persona: 'arona',
      key: 'provider',
      value: 'claude-agent',
    });
    await handlers.handleInteraction(flip);
    const text = replyText(flip);
    expect(text).toContain('Saved `arona.provider` = `claude-agent`');
    expect(text).toContain('Previous stored value: `codex`');
    expect(text).toContain(
      'Active provider for next dispatch: `claude-agent`',
    );
    expect(text).toContain('(was: `codex`)');
    expect(text).toContain(
      'In-flight dispatches keep their current provider until they finish.',
    );
  });

  it('plana provider change includes the next-dispatch hint with "none" when no prior override existed', async () => {
    const handlers = createHandlers(storePath);
    const interaction = new FakeDiscordInteraction('config', {
      action: 'set',
      persona: 'plana',
      key: 'provider',
      value: 'codex',
    });

    await handlers.handleInteraction(interaction);
    const text = replyText(interaction);
    expect(text).toContain('Saved `plana.provider` = `codex`');
    // No prior override → the "Previous stored value" line is omitted entirely.
    expect(text).not.toContain('Previous stored value:');
    // …but the next-dispatch hint still surfaces, with `was: none`.
    expect(text).toContain('Active provider for next dispatch: `codex`');
    expect(text).toContain('(was: none)');
    expect(text).toContain(
      'In-flight dispatches keep their current provider until they finish.',
    );
  });

  it('non-provider keys (e.g. model) do NOT include the next-dispatch hint (regression)', async () => {
    const handlers = createHandlers(storePath);
    const interaction = new FakeDiscordInteraction('config', {
      action: 'set',
      persona: 'arona',
      key: 'model',
      value: 'gpt-5.5',
    });

    await handlers.handleInteraction(interaction);
    const text = replyText(interaction);
    expect(text).toContain('Saved `arona.model` = `gpt-5.5`');
    // The provider-specific boundary message must NOT appear for model edits.
    expect(text).not.toContain('Active provider for next dispatch');
    expect(text).not.toContain('In-flight dispatches keep their current provider');
  });
});
