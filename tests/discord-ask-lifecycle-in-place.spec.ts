import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  type RuntimeDriverResult,
} from '../src/index.js';
import { withSynthesizedCause } from './helpers/wu-v-cause.js';
import { FakeDiscordInteraction, flushDiscordAsyncWork } from './helpers/discord.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

// UX-23 (cycle 8) — `/ask` task lifecycle (accept → running → terminal)
// flows through `editReply` so the same Discord message is updated in
// place, replacing the previous accepted/running/terminal followUp
// fan-out (4 messages) with a single in-place message (1 visible
// message in the Discord channel; the test fake records every editReply
// call as a separate array entry).

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
  taskIdFactory: () => 'inplace-test-id',
};

function createInPlaceHandlers(): {
  readonly handlers: DiscordCommandHandlers;
  readonly taskRegistry: DiscordTaskRegistry;
} {
  const dispatcher = new Dispatcher(
    new InProcessComputeNode(
      new AgentRuntime({
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'complete',
            detail: 'in-place-test',
          });
          return withSynthesizedCause(context, {
            outcome: 'success',
            reason: '2147483647',
            provenance: 'in-place-test-driver',
            artifactLocation: 'results/discord-task',
          });
        },
      }),
    ),
  );
  const taskRegistry = new DiscordTaskRegistry();
  const handlers = new DiscordCommandHandlers({
    arona: new Arona(new Plana(), dispatcher),
    dispatcher,
    taskRegistry,
    requestFactory: new DefaultDiscordTaskRequestFactory(
      defaultRequestFactoryOptions,
    ),
  });
  return { handlers, taskRegistry };
}

describe('UX-23 — /ask lifecycle in-place edit', () => {
  it('emits accept + running + terminal all through editReply, with no followUp', async () => {
    const { handlers } = createInPlaceHandlers();
    const interaction = new FakeDiscordInteraction('ask', {
      instruction: '2^32 미만의 가장 큰 메르센 소수를 출력',
    });
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    // The fake adapter records each editReply call as a separate entry;
    // in production Discord replaces the same message each time. The
    // user-complaint case (one short task → 4 channel messages)
    // collapses to a single in-place updated message.
    expect(interaction.followUpReplies).toHaveLength(0);
    expect(interaction.editedReplies.length).toBeGreaterThanOrEqual(2);
  });

  it('the FINAL editReply payload carries the terminal result content', async () => {
    const { handlers } = createInPlaceHandlers();
    const interaction = new FakeDiscordInteraction('ask', {
      instruction: 'compute',
    });
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    // The last editReply call is what Discord users will see — it
    // must be the terminal state, not a stale "running" intermediate.
    const lastEdit = interaction.editedReplies[interaction.editedReplies.length - 1];
    expect(lastEdit).toBeDefined();
    expect(lastEdit!.content).toContain('finished with `success`');
    expect(lastEdit!.content).toContain('2147483647');
  });

  it('lifecycle progression remains observable across the editReply array', async () => {
    const { handlers } = createInPlaceHandlers();
    const interaction = new FakeDiscordInteraction('ask', {
      instruction: 'compute',
    });
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    const contents = interaction.editedReplies.map((p) => p.content);
    // Tests still see every state — accept then running then terminal —
    // because the fake appends each editReply call. This makes lifecycle
    // tests robust to the in-place collapse: assertions can search the
    // array for any phase content.
    expect(contents.some((c) => c.includes('Accepted task'))).toBe(true);
    expect(contents.some((c) => c.includes('finished with `success`'))).toBe(true);
  });
});
