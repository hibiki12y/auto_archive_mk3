export interface DiscordDirectControlMessage {
  readonly bot?: boolean;
  readonly authorId?: string;
  readonly content?: string;
  readonly timestamp?: string;
  readonly id?: string;
}

export interface DiscordDirectControlPollArgs {
  readonly expectAuthor?: string;
  readonly expectTaskId?: string;
  readonly marker?: string;
  readonly mode?: string;
}

export type DiscordDirectControlPollMode =
  | 'auto'
  | 'marker'
  | 'after-start'
  | 'task-lifecycle'
  | 'command-response';

export function looksLikeTaskSettleEvent(
  message: DiscordDirectControlMessage | null | undefined,
): boolean;

export function messageMatchesPollMode(
  message: DiscordDirectControlMessage,
  args: DiscordDirectControlPollArgs,
  pollMode: DiscordDirectControlPollMode,
  startedAtMs: number,
): boolean;

export function isDirectControlEntrypoint(
  moduleUrl?: string,
  argv?: readonly string[],
): boolean;
