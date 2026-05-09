import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  InMemoryControlPlaneLedger,
  extractDiscordMessageId,
  type ControlPlaneEvent,
  type RuntimeDriverResult,
  type DiscordCommandInteractionAdapter,
  type DiscordMessagePayload,
} from '../src/index.js';
import { withSynthesizedCause } from './helpers/wu-v-cause.js';
import { FakeDiscordInteraction, flushDiscordAsyncWork } from './helpers/discord.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

// UX-25 (cycle 11) — `task.delivery_observed` records every editReply
// / followUp through the deliver path. Same messageId across multiple
// editReply ops = cycle 8/10 in-place edit verified without needing a
// bot-token Discord REST fetch (which the Auto Mode classifier blocks).

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
  taskIdFactory: () => 'observed-test-id',
};

class StableMessageIdInteraction
  extends FakeDiscordInteraction
  implements DiscordCommandInteractionAdapter
{
  // The adapter "edits" the same Discord message — we fake the wire by
  // returning the same id from every editReply call (matches the
  // production NL adapter behavior after cycle 10).
  override editReply = async (payload: DiscordMessagePayload): Promise<unknown> => {
    this.editedReplies.push(payload);
    return { id: 'discord-msg-stable' };
  };
  override followUp = async (payload: DiscordMessagePayload): Promise<unknown> => {
    this.followUpReplies.push(payload);
    return { id: `discord-msg-followup-${this.followUpReplies.length}` };
  };
  extractMessageId = extractDiscordMessageId;
}

function createObservableHandlers(): {
  readonly handlers: DiscordCommandHandlers;
  readonly ledger: InMemoryControlPlaneLedger;
} {
  const ledger = new InMemoryControlPlaneLedger();
  const dispatcher = new Dispatcher(
    new InProcessComputeNode(
      new AgentRuntime({
        async run(context): Promise<RuntimeDriverResult> {
          void context.emit({
            kind: 'agent-step',
            step: 'complete',
            detail: 'observed-test',
          });
          return withSynthesizedCause(context, {
            outcome: 'success',
            reason: '2147483647',
            provenance: 'observed-test-driver',
            artifactLocation: 'results/discord-task',
          });
        },
      }),
    ),
  );
  const handlers = new DiscordCommandHandlers({
    arona: new Arona(new Plana(), dispatcher),
    dispatcher,
    taskRegistry: new DiscordTaskRegistry(),
    requestFactory: new DefaultDiscordTaskRequestFactory(
      defaultRequestFactoryOptions,
    ),
    controlLedger: ledger,
  });
  return { handlers, ledger };
}

function deliveryEventsFor(
  ledger: InMemoryControlPlaneLedger,
  taskId: string,
): readonly ControlPlaneEvent[] {
  return ledger
    .loadAll()
    .filter(
      (event) => event.type === 'task.delivery_observed' && event.taskId === taskId,
    );
}

describe('UX-25 — task.delivery_observed ledger event', () => {
  it('records one delivery_observed event per editReply with the captured message id', async () => {
    const { handlers, ledger } = createObservableHandlers();
    const interaction = new StableMessageIdInteraction('ask', {
      instruction: 'compute',
    });
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    const events = deliveryEventsFor(ledger, 'discord-task-observed-test-id');
    expect(events.length).toBeGreaterThanOrEqual(2);
    const editReplyEvents = events.filter(
      (event) => event.payload['operation'] === 'editReply',
    );
    expect(editReplyEvents.length).toBeGreaterThanOrEqual(2);
    // All editReply ops landed on the SAME messageId — cycle 8/10
    // in-place edit verified at the ledger level.
    const distinctMessageIds = new Set(
      editReplyEvents
        .map((event) => event.payload['messageId'])
        .filter((id): id is string => typeof id === 'string'),
    );
    expect(distinctMessageIds.size).toBe(1);
    expect([...distinctMessageIds][0]).toBe('discord-msg-stable');
  });

  it('captures the eventType label per delivery (accept / running / terminal)', async () => {
    const { handlers, ledger } = createObservableHandlers();
    const interaction = new StableMessageIdInteraction('ask', {
      instruction: 'compute',
    });
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    const events = deliveryEventsFor(ledger, 'discord-task-observed-test-id');
    const eventTypes = new Set(events.map((event) => event.payload['eventType']));
    expect(eventTypes.has('ask-accepted')).toBe(true);
    expect(eventTypes.has('terminal-result')).toBe(true);
  });

  it('omits messageId when the adapter does not implement extractMessageId', async () => {
    const { handlers, ledger } = createObservableHandlers();
    // Plain FakeDiscordInteraction has no extractMessageId; the deliver
    // path still appends the event, just without the messageId field.
    const interaction = new FakeDiscordInteraction('ask', {
      instruction: 'compute',
    });
    await handlers.handleInteraction(interaction);
    await flushDiscordAsyncWork();

    const events = deliveryEventsFor(ledger, 'discord-task-observed-test-id');
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const event of events) {
      expect(event.payload['messageId']).toBeUndefined();
      // operation + eventType still recorded (taskId + idempotencyKey too).
      expect(typeof event.payload['operation']).toBe('string');
      expect(typeof event.payload['eventType']).toBe('string');
      expect(typeof event.payload['idempotencyKey']).toBe('string');
    }
  });
});

describe('extractDiscordMessageId', () => {
  it('returns the id field for Message-shaped values', () => {
    expect(extractDiscordMessageId({ id: 'abc123' })).toBe('abc123');
  });
  it('returns undefined for null / undefined / non-Message inputs', () => {
    expect(extractDiscordMessageId(null)).toBeUndefined();
    expect(extractDiscordMessageId(undefined)).toBeUndefined();
    expect(extractDiscordMessageId({})).toBeUndefined();
    expect(extractDiscordMessageId({ id: 0 })).toBeUndefined();
    expect(extractDiscordMessageId({ id: '' })).toBeUndefined();
  });
});
