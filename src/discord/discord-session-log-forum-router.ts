/**
 * Discord session-log forum router.
 *
 * Spec: specs/CURRENT/discord-session-log-forum.md
 *
 * Routes lifecycle followUp deliveries from `DiscordCommandHandlers` to a
 * per-Task thread inside a Discord GUILD_FORUM channel instead of replying
 * back to the original chat channel. Lazy thread creation: the first
 * followUp for a Task ID materializes the thread (the first message becomes
 * the thread's starter post). The original `editReply` (initial Accepted)
 * stays on the source interaction so the user has an immediate reply.
 *
 * The router is fail-open: any thread-creation or thread-send error returns
 * `{ delivered: 'channel-fallback' }` so the caller can still send the
 * message via the source channel — losing the thread is preferable to
 * losing the lifecycle update.
 */
import type { DiscordMessagePayload } from './discord-result-renderer.js';
import type { DiscordDeliveryEventType } from './delivery/discord-delivery-types.js';

export interface DiscordSessionLogForumRouteInput {
  readonly taskId: string;
  readonly payload: DiscordMessagePayload;
  readonly eventType?: DiscordDeliveryEventType;
}

export interface DiscordSessionLogForumRouteOutcome {
  readonly delivered: 'thread' | 'channel-fallback';
  readonly threadId?: string;
  readonly fallbackReason?: string;
}

export interface DiscordSessionLogForumRouter {
  routeFollowUp(
    input: DiscordSessionLogForumRouteInput,
  ): Promise<DiscordSessionLogForumRouteOutcome>;
}

export interface DiscordForumThreadHandle {
  readonly id: string;
  send(payload: DiscordMessagePayload): Promise<unknown>;
}

export interface DiscordForumChannelHandle {
  readonly id: string;
  threads: {
    create(input: {
      name: string;
      message: { content: string };
    }): Promise<DiscordForumThreadHandle>;
  };
}

export interface DiscordForumChannelResolver {
  resolveForumChannel(forumChannelId: string): Promise<DiscordForumChannelHandle>;
}

export interface DiscordSessionLogForumRouterOptions {
  readonly forumChannelId: string;
  readonly resolver: DiscordForumChannelResolver;
  readonly threadNamePrefix?: string;
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

/**
 * Default in-process router. Holds a Map<taskId, Promise<thread>>; the first
 * invocation per Task ID resolves the forum channel and creates a thread
 * whose starter message is the followUp payload. Subsequent invocations
 * await the cached promise and call `thread.send`.
 */
export class DefaultDiscordSessionLogForumRouter
  implements DiscordSessionLogForumRouter
{
  private readonly threadByTaskId = new Map<
    string,
    Promise<DiscordForumThreadHandle>
  >();

  constructor(private readonly options: DiscordSessionLogForumRouterOptions) {
    if (options.forumChannelId.trim().length === 0) {
      throw new Error(
        'DiscordSessionLogForumRouter requires a non-empty forumChannelId.',
      );
    }
  }

  async routeFollowUp(
    input: DiscordSessionLogForumRouteInput,
  ): Promise<DiscordSessionLogForumRouteOutcome> {
    const cached = this.threadByTaskId.get(input.taskId);
    if (cached === undefined) {
      const created = this.createThread(input);
      this.threadByTaskId.set(input.taskId, created);
      try {
        const thread = await created;
        return { delivered: 'thread', threadId: thread.id };
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

  private async createThread(
    input: DiscordSessionLogForumRouteInput,
  ): Promise<DiscordForumThreadHandle> {
    const channel = await this.options.resolver.resolveForumChannel(
      this.options.forumChannelId,
    );
    const name = buildThreadName(
      input.taskId,
      this.options.threadNamePrefix ?? DEFAULT_THREAD_NAME_PREFIX,
    );
    const content = input.payload.content;
    if (content.length === 0) {
      throw new Error(
        'Forum thread starter message cannot be empty; followUp payload had no content.',
      );
    }
    return channel.threads.create({ name, message: { content } });
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
