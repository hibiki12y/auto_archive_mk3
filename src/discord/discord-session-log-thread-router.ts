/**
 * Discord session-log thread router.
 *
 * Spec: specs/CURRENT/discord-session-log-thread.md
 *
 * Routes lifecycle followUp deliveries from `DiscordCommandHandlers` to a
 * per-Task thread under a regular Discord text channel (the "session-log
 * parent channel"), instead of replying back to the original chat channel.
 * Thread creation: `parent.threads.create({ name })` returns a thread
 * handle with no required starter, and the first followUp payload is sent
 * via `thread.send(payload)`. The original `editReply` (initial Accepted)
 * stays on the source interaction so the user has an immediate reply.
 *
 * The router is fail-open: any thread-creation or thread-send error returns
 * `{ delivered: 'channel-fallback' }` so the caller can still send the
 * message via the source channel — losing the thread is preferable to
 * losing the lifecycle update.
 *
 * The same router shape works against a Discord forum channel via a thin
 * resolver adapter that synthesizes an empty thread by sending a placeholder
 * starter, but the canonical operating model is plain text channel +
 * thread-per-Task. See spec §"Forum vs Thread" for the operational
 * trade-off and §"Production wiring" for the discord.js binding plan.
 */
import type { DiscordMessagePayload } from './discord-result-renderer.js';
import type { DiscordDeliveryEventType } from './delivery/discord-delivery-types.js';

export interface DiscordSessionLogThreadRouteInput {
  readonly taskId: string;
  readonly payload: DiscordMessagePayload;
  readonly eventType?: DiscordDeliveryEventType;
}

export interface DiscordSessionLogThreadRouteOutcome {
  readonly delivered: 'thread' | 'channel-fallback';
  readonly threadId?: string;
  readonly fallbackReason?: string;
}

export interface DiscordSessionLogThreadRouter {
  routeFollowUp(
    input: DiscordSessionLogThreadRouteInput,
  ): Promise<DiscordSessionLogThreadRouteOutcome>;
}

export interface DiscordSessionLogThreadHandle {
  readonly id: string;
  send(payload: DiscordMessagePayload): Promise<unknown>;
}

export interface DiscordSessionLogParentChannelHandle {
  readonly id: string;
  threads: {
    create(input: {
      name: string;
      autoArchiveDurationMinutes?: number;
    }): Promise<DiscordSessionLogThreadHandle>;
  };
}

export interface DiscordSessionLogParentChannelResolver {
  resolveParentChannel(
    parentChannelId: string,
  ): Promise<DiscordSessionLogParentChannelHandle>;
}

export interface DiscordSessionLogThreadRouterOptions {
  readonly parentChannelId: string;
  readonly resolver: DiscordSessionLogParentChannelResolver;
  readonly threadNamePrefix?: string;
  readonly autoArchiveDurationMinutes?: number;
  /**
   * Optional sink so operators can observe thread route failures without
   * silencing the underlying error. Errors are still classified into
   * `channel-fallback` outcomes for the caller; the sink only mirrors them
   * for logging/metrics.
   */
  readonly onError?: (error: unknown, context: { taskId: string }) => void;
}

const DEFAULT_THREAD_NAME_PREFIX = 'Task ';
const MAX_DISCORD_THREAD_NAME_LENGTH = 100;
const DEFAULT_AUTO_ARCHIVE_DURATION_MINUTES = 1440; // 24h

/**
 * Default in-process router. Holds a Map<taskId, Promise<thread>>; the first
 * invocation per Task ID resolves the parent channel, creates a thread,
 * and sends the followUp payload as the first thread message. Subsequent
 * invocations await the cached thread and call `thread.send`.
 */
export class DefaultDiscordSessionLogThreadRouter
  implements DiscordSessionLogThreadRouter
{
  private readonly threadByTaskId = new Map<
    string,
    Promise<DiscordSessionLogThreadHandle>
  >();

  constructor(private readonly options: DiscordSessionLogThreadRouterOptions) {
    if (options.parentChannelId.trim().length === 0) {
      throw new Error(
        'DiscordSessionLogThreadRouter requires a non-empty parentChannelId.',
      );
    }
  }

  async routeFollowUp(
    input: DiscordSessionLogThreadRouteInput,
  ): Promise<DiscordSessionLogThreadRouteOutcome> {
    const cached = this.threadByTaskId.get(input.taskId);
    if (cached === undefined) {
      const created = this.createThreadAndSend(input);
      const cachedThread = created.then((result) => result.thread);
      // Attach a no-op handler so the cached promise does not surface as an
      // unhandled rejection if creation fails before any awaiter consumes it.
      cachedThread.catch(() => undefined);
      this.threadByTaskId.set(input.taskId, cachedThread);
      try {
        const result = await created;
        return { delivered: 'thread', threadId: result.thread.id };
      } catch (error) {
        this.threadByTaskId.delete(input.taskId);
        this.options.onError?.(error, { taskId: input.taskId });
        return {
          delivered: 'channel-fallback',
          fallbackReason: errorReason(error, 'thread-create-failed'),
        };
      }
    }
    try {
      const thread = await cached;
      await thread.send(input.payload);
      return { delivered: 'thread', threadId: thread.id };
    } catch (error) {
      this.options.onError?.(error, { taskId: input.taskId });
      return {
        delivered: 'channel-fallback',
        fallbackReason: errorReason(error, 'thread-send-failed'),
      };
    }
  }

  private async createThreadAndSend(
    input: DiscordSessionLogThreadRouteInput,
  ): Promise<{ thread: DiscordSessionLogThreadHandle }> {
    if (input.payload.content.length === 0) {
      throw new Error(
        'Thread first message cannot be empty; followUp payload had no content.',
      );
    }
    const channel = await this.options.resolver.resolveParentChannel(
      this.options.parentChannelId,
    );
    const name = buildThreadName(
      input.taskId,
      this.options.threadNamePrefix ?? DEFAULT_THREAD_NAME_PREFIX,
    );
    const thread = await channel.threads.create({
      name,
      autoArchiveDurationMinutes:
        this.options.autoArchiveDurationMinutes ??
        DEFAULT_AUTO_ARCHIVE_DURATION_MINUTES,
    });
    await thread.send(input.payload);
    return { thread };
  }
}

export function buildThreadName(taskId: string, prefix: string): string {
  const sanitizedPrefix = prefix.length > 0 ? prefix : DEFAULT_THREAD_NAME_PREFIX;
  const candidate = `${sanitizedPrefix}${taskId}`;
  if (candidate.length <= MAX_DISCORD_THREAD_NAME_LENGTH) {
    return candidate;
  }
  return candidate.slice(0, MAX_DISCORD_THREAD_NAME_LENGTH);
}

function errorReason(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return `${fallback}:${error.message.slice(0, 80)}`;
  }
  return fallback;
}
