/**
 * UX-26 (cycle 12) — classify mention-driven natural-language input as
 * `task-explicit`, `task-confirm`, `chat-with-task-hint`, or
 * `chat-only`. The handler uses this to decide between immediate
 * chat reply and full task dispatch lifecycle.
 *
 * Default behaviour pre-cycle 12: every mention → `task-explicit`.
 * That produced the channel-noise + unintuitive-`/status`-tracking the
 * user complained about (2026-05-09 feedback).
 *
 * New default behaviour (when wired by the handler with the env flag
 * `AUTO_ARCHIVE_DISCORD_MENTION_DEFAULT_CHAT=on`): mention → `chat-only`
 * unless the message contains an explicit task keyword OR is a
 * `task-confirm` answer to a prior `chat-with-task-hint`.
 *
 * Heuristics (Korean + English, keyword-based — LLM-free first cut):
 *
 *   task-explicit:
 *     - starts with `task:` (case-insensitive)
 *     - contains `task로`, `task 로`, `task처리`, `task 처리`
 *     - contains `처리해줘`, `dispatch`, `실행해줘`, `시작해줘`
 *
 *   task-confirm (only valid when caller passes hasPriorChatHint=true):
 *     - SHORT message (≤ 30 chars after trim) AND
 *     - matches `^(네|예|좋아|진행|task로 진행|task|yes|y|sure|ok)\b` (case-insensitive)
 *
 *   chat-with-task-hint (looks like a workload, bot will offer task):
 *     - length > 50 chars, OR
 *     - contains a "compute-y" verb in Korean or English:
 *       분석, 조사, 계산, 출력, 구해, 찾아, 만들어, 작성, 실행, 검토, 보고서,
 *       analyze, compute, find, build, write, generate, calculate, report
 *
 *   chat-only:
 *     - everything else (greetings, short questions, chitchat)
 */

const TASK_EXPLICIT_PATTERNS: readonly RegExp[] = [
  /^\s*task\s*:/iu,
  /\btask\s*[로으로]\s*(?:처리|진행|시작|대신|작업)/u,
  /\b(?:dispatch|task[- ]?dispatch)\b/iu,
  /처리해줘/u,
  /실행해줘/u,
  /시작해줘/u,
];

// Use a `(?=\s|$)` lookahead instead of `\b` because JavaScript's
// `\b` only triggers around ASCII word characters — Korean particles
// like 네 / 예 / 진행 are not word characters, so `네\b` never matches
// "네 진행". The lookahead works for both ASCII and Hangul boundaries.
// Longer alternatives first so "task로 진행" matches the longer arm
// before the bare "task" prefix.
const TASK_CONFIRM_PATTERN: RegExp =
  /^(?:task\s*로\s*진행|task|네|예|좋아|진행|yes|y|sure|ok|okay)(?=\s|$)/iu;

const COMPUTE_VERB_PATTERN: RegExp =
  /(?:분석|조사|계산|출력|구해|찾아|만들어|작성|실행|검토|보고서|analyze|compute|find|build|write|generate|calculate|report)/iu;

export type MentionTaskIntent =
  | { readonly kind: 'task-explicit'; readonly instruction: string; readonly reason: string }
  | { readonly kind: 'task-confirm'; readonly reason: string }
  | { readonly kind: 'chat-with-task-hint'; readonly instruction: string }
  | { readonly kind: 'chat-only'; readonly instruction: string };

export interface MentionIntentClassificationInput {
  /**
   * The instruction text extracted by `extractNaturalLanguageAskInstruction`
   * (i.e. with the mention prefix already stripped).
   */
  readonly instruction: string;
  /**
   * `true` if the bot recently posted a `chat-with-task-hint` reply in
   * the same channel and the TTL is not expired. Required for
   * `task-confirm` classification — without a prior hint, a bare "yes"
   * is just chat.
   */
  readonly hasPriorChatHint: boolean;
}

export function classifyMentionTaskIntent(
  input: MentionIntentClassificationInput,
): MentionTaskIntent {
  const trimmed = input.instruction.trim();
  if (trimmed.length === 0) {
    return { kind: 'chat-only', instruction: trimmed };
  }

  // task-explicit takes precedence — explicit user intent wins.
  for (const pattern of TASK_EXPLICIT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        kind: 'task-explicit',
        instruction: trimmed,
        reason: `matched-pattern:${pattern.source.slice(0, 32)}`,
      };
    }
  }

  // task-confirm is contextual: only meaningful when the bot recently
  // offered a task escalation in this channel.
  if (input.hasPriorChatHint && trimmed.length <= 30 && TASK_CONFIRM_PATTERN.test(trimmed)) {
    return {
      kind: 'task-confirm',
      reason: `confirm-shape-after-prior-hint`,
    };
  }

  // chat-with-task-hint — looks like a workload the bot should offer
  // to dispatch. Length-based OR compute-verb-based.
  if (trimmed.length > 50 || COMPUTE_VERB_PATTERN.test(trimmed)) {
    return { kind: 'chat-with-task-hint', instruction: trimmed };
  }

  return { kind: 'chat-only', instruction: trimmed };
}

/**
 * Per-channel TTL state for the task-escalation handshake. The handler
 * holds an instance of `MentionChatHintState` and consults
 * `hasActiveHint(channelId)` before classifying, then `recordHint` /
 * `clearHint` as the conversation progresses.
 *
 * TTL keeps the channel from getting stuck in a "waiting on confirm"
 * mode forever — after `ttlMs` (default 5 min) the next `yes` is
 * treated as plain chat again.
 */
export interface MentionChatHintRecord {
  readonly channelId: string;
  readonly userId: string;
  readonly originalInstruction: string;
  readonly recordedAtMs: number;
  readonly expiresAtMs: number;
}

export interface MentionChatHintStateOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_HINT_TTL_MS = 5 * 60 * 1_000;

export class MentionChatHintState {
  private readonly hints = new Map<string, MentionChatHintRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: MentionChatHintStateOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_HINT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  recordHint(input: {
    readonly channelId: string;
    readonly userId: string;
    readonly originalInstruction: string;
  }): MentionChatHintRecord {
    const recordedAtMs = this.now();
    const record: MentionChatHintRecord = {
      channelId: input.channelId,
      userId: input.userId,
      originalInstruction: input.originalInstruction,
      recordedAtMs,
      expiresAtMs: recordedAtMs + this.ttlMs,
    };
    this.hints.set(this.keyFor(input.channelId, input.userId), record);
    return record;
  }

  /**
   * Returns the active hint for (channelId, userId) if not expired.
   * Side-effect-free: stale entries are NOT cleared until the next
   * `recordHint` / `clearHint` / `consumeHint` so callers can inspect
   * timing without mutating state.
   */
  getActiveHint(
    channelId: string,
    userId: string,
  ): MentionChatHintRecord | undefined {
    const key = this.keyFor(channelId, userId);
    const record = this.hints.get(key);
    if (record === undefined) {
      return undefined;
    }
    if (record.expiresAtMs <= this.now()) {
      return undefined;
    }
    return record;
  }

  consumeHint(
    channelId: string,
    userId: string,
  ): MentionChatHintRecord | undefined {
    const record = this.getActiveHint(channelId, userId);
    if (record !== undefined) {
      this.hints.delete(this.keyFor(channelId, userId));
    }
    return record;
  }

  clearHint(channelId: string, userId: string): boolean {
    return this.hints.delete(this.keyFor(channelId, userId));
  }

  size(): number {
    return this.hints.size;
  }

  private keyFor(channelId: string, userId: string): string {
    return `${channelId}::${userId}`;
  }
}
