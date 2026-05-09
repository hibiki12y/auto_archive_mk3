import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ClientOptions,
  type Message,
} from 'discord.js';

import type { Arona } from '../core/arona.js';
import type { Dispatcher } from '../core/dispatcher.js';
import type { RuntimeApprovalRegistry } from '../core/runtime-approval-registry.js';
import type { TraitModuleRegistry } from '../core/trait-module-loader.js';
import type { TraitUsageTelemetryPort } from '../core/trait-usage-telemetry.js';
import type { ControlPlaneLedgerPort } from '../control/control-plane-ledger.js';
import {
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  type DefaultDiscordTaskRequestFactoryOptions,
  type DiscordCommandInteractionAdapter,
  type DiscordTaskMessageHandle,
} from './discord-command-handlers.js';
import {
  buildDiscordFirstSliceCommands,
  isDiscordFirstSliceCommandName,
  type DiscordFirstSliceCommandName,
} from './discord-command-registry.js';
import type {
  DiscordButtonStyle,
  DiscordDoctorStatus,
  DiscordMessagePayload,
} from './discord-result-renderer.js';
import type { DiscordAccessPolicy } from './discord-access-policy.js';
import type { DiscordAuthDatabase } from './discord-auth-database.js';
import {
  createDiscordInstructionEnvelope,
  formatDiscordInstructionEnvelope,
} from './discord-instruction-envelope.js';
import { DiscordTaskRegistry } from './discord-task-registry.js';
import {
  BoundaryValidationError,
  requireObject,
  requireString,
  validateIpcIngress,
} from '../contracts/boundary-validators.js';

export interface RegisterDiscordFirstSliceCommandsOptions {
  token: string;
  applicationId: string;
  guildId?: string;
}

export async function registerDiscordFirstSliceCommands(
  options: RegisterDiscordFirstSliceCommandsOptions,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(options.token);
  const body = buildDiscordFirstSliceCommands();

  if (options.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(options.applicationId, options.guildId),
      { body },
    );
    return;
  }

  await rest.put(Routes.applicationCommands(options.applicationId), { body });
}

interface DiscordChatInputInteractionIngress {
  readonly commandName: string;
  readonly user: {
    readonly id: string;
  };
  readonly guildId?: string | null;
  readonly channelId?: string | null;
  readonly options: {
    getString(name: string, required?: boolean): unknown;
  };
  deferReply(options?: { flags?: number }): unknown;
  editReply(payload: unknown): unknown;
  followUp(payload: unknown): unknown;
  // UX-24 (cycle 9): optional discord.js method — `interaction.fetchReply()`
  // returns the bot's most recent reply as a `Message`. The wrapped
  // adapter exposes only `startThread`, so adapters that lack this
  // method (test fakes, legacy ingresses) gracefully proceed with
  // channel-only delivery.
  fetchReply?(): unknown;
}

interface DiscordMessageCreateIngress {
  readonly id?: string;
  readonly content: string;
  readonly createdTimestamp?: number;
  readonly author: {
    readonly id: string;
    readonly bot?: boolean;
  };
  readonly guildId?: string | null;
  readonly channelId?: string | null;
  reply(payload: unknown): unknown;
}

function requireFunction(
  value: unknown,
  path: ReadonlyArray<string | number>,
): asserts value is (...args: unknown[]) => unknown {
  if (typeof value !== 'function') {
    throw new BoundaryValidationError(
      'B-IPC',
      `${path.join('.')} must be a function.`,
    );
  }
}

function assertDiscordChatInputInteractionIngress(
  raw: unknown,
): asserts raw is DiscordChatInputInteractionIngress {
  requireObject(raw, 'B-IPC', ['interaction']);
  requireString(raw.commandName, 'B-IPC', ['interaction', 'commandName']);
  requireObject(raw.user, 'B-IPC', ['interaction', 'user']);
  requireString(raw.user.id, 'B-IPC', ['interaction', 'user', 'id']);
  if (raw.guildId !== null && raw.guildId !== undefined) {
    requireString(raw.guildId, 'B-IPC', ['interaction', 'guildId']);
  }
  if (raw.channelId !== null && raw.channelId !== undefined) {
    requireString(raw.channelId, 'B-IPC', ['interaction', 'channelId']);
  }
  requireObject(raw.options, 'B-IPC', ['interaction', 'options']);
  requireFunction(raw.options.getString, ['interaction', 'options', 'getString']);
  requireFunction(raw.deferReply, ['interaction', 'deferReply']);
  requireFunction(raw.editReply, ['interaction', 'editReply']);
  requireFunction(raw.followUp, ['interaction', 'followUp']);
}

function assertDiscordMessageCreateIngress(
  raw: unknown,
): asserts raw is DiscordMessageCreateIngress {
  requireObject(raw, 'B-IPC', ['message']);
  if (raw.id !== undefined) {
    requireString(raw.id, 'B-IPC', ['message', 'id']);
  }
  requireString(raw.content, 'B-IPC', ['message', 'content']);
  if (
    raw.createdTimestamp !== undefined &&
    (typeof raw.createdTimestamp !== 'number' ||
      !Number.isFinite(raw.createdTimestamp))
  ) {
    throw new BoundaryValidationError(
      'B-IPC',
      'message.createdTimestamp must be a finite number when provided.',
    );
  }
  requireObject(raw.author, 'B-IPC', ['message', 'author']);
  requireString(raw.author.id, 'B-IPC', ['message', 'author', 'id']);
  if (raw.author.bot !== undefined && typeof raw.author.bot !== 'boolean') {
    throw new BoundaryValidationError(
      'B-IPC',
      'message.author.bot must be a boolean when provided.',
    );
  }
  if (raw.channelId !== null && raw.channelId !== undefined) {
    requireString(raw.channelId, 'B-IPC', ['message', 'channelId']);
  }
  if (raw.guildId !== null && raw.guildId !== undefined) {
    requireString(raw.guildId, 'B-IPC', ['message', 'guildId']);
  }
  requireFunction(raw.reply, ['message', 'reply']);
}

function summarizeInteractionHandlerError(error: unknown): {
  name: string;
  message: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    name: 'non-error',
    message: String(error),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface NaturalLanguageMessageOptions {
  readonly prefixes?: readonly string[];
  readonly triggerMode?: 'mention' | 'mention-or-prefix';
  readonly contextHistory?: readonly DiscordMessageContextEntry[];
  readonly allowNonLeadingMentions?: boolean;
  readonly source?: 'natural-language' | 'slash-text';
}

export interface DiscordMessageContextEntry {
  readonly messageId?: string;
  readonly guildId?: string;
  readonly channelId?: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly content: string;
  readonly timestamp: string;
}

const NATURAL_LANGUAGE_ADDRESS_SEPARATOR =
  String.raw`(?:\s+|[,，:：;；.!?！？\-–—]+\s*)`;
const NATURAL_LANGUAGE_ADDRESS_PUNCTUATION =
  String.raw`[,，:：;；.!?！？\-–—]`;
const NATURAL_LANGUAGE_VOCATIVE_SUFFIX =
  String.raw`(?:야|아|에게|한테|님)`;
const NATURAL_LANGUAGE_LEADING_ATTENTION =
  String.raw`(?:(?:hey|hi|hello|ok|okay|안녕|저기)\s+)?`;
const DISCORD_TASK_ID_PATTERN = /\bdiscord-task-[A-Za-z0-9_-]+\b/u;

function normalizeNaturalLanguageAskInstruction(
  rawInstruction: string,
): string | undefined {
  let instruction = rawInstruction.trim();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const before = instruction;
    instruction = instruction
      .replace(/^[\s,，:：;；.!?！？\-–—]+/u, '')
      .trimStart();
    instruction = instruction
      .replace(/^(?:please|pls)\b[\s,，:：;；.!?！？\-–—]*/iu, '')
      .trimStart();
    instruction = instruction
      .replace(/^(?:좀|제발)(?:\s+|[,，:：;；.!?！？\-–—]+)*/u, '')
      .trimStart();
    instruction = instruction
      .replace(
        /^(?:부탁해요|부탁합니다|부탁해|요청해요|요청합니다|요청해)(?=$|\s|[,，:：;；.!?！？\-–—])[\s,，:：;；.!?！？\-–—]*/u,
        '',
      )
      .trimStart();

    if (instruction === before) {
      break;
    }
  }

  return instruction.length > 0 ? instruction : undefined;
}

function sortedNaturalLanguagePrefixes(prefixes: readonly string[]): string[] {
  return [...new Set(prefixes.map((prefix) => prefix.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
}

function naturalLanguageAddressSuffixPattern(): string {
  return String.raw`(?:${NATURAL_LANGUAGE_ADDRESS_SEPARATOR}|${NATURAL_LANGUAGE_VOCATIVE_SUFFIX}(?=$|\s|${NATURAL_LANGUAGE_ADDRESS_PUNCTUATION})(?:${NATURAL_LANGUAGE_ADDRESS_SEPARATOR})?)`;
}

function maskFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/gu, (match) => ' '.repeat(match.length));
}

function findNonLeadingBotMentionOutsideFencedCodeBlock(
  content: string,
  botUserId: string,
): { index: number; length: number } | undefined {
  const maskedContent = maskFencedCodeBlocks(content);
  const mentionPattern = new RegExp(`<@!?${escapeRegExp(botUserId)}>`, 'giu');
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(maskedContent)) !== null) {
    const leadingText = maskedContent.slice(0, match.index);
    if (leadingText.trim().length === 0) {
      continue;
    }
    return {
      index: match.index,
      length: match[0].length,
    };
  }

  return undefined;
}

function extractNonLeadingMentionInstruction(
  content: string,
  botUserId: string,
): string | undefined {
  const mention = findNonLeadingBotMentionOutsideFencedCodeBlock(
    content,
    botUserId,
  );
  if (!mention) {
    return undefined;
  }

  return normalizeNaturalLanguageAskInstruction(
    `${content.slice(0, mention.index)} ${content.slice(
      mention.index + mention.length,
    )}`,
  );
}

export function formatDiscordContextualInstruction(
  instruction: string,
  contextHistory: readonly DiscordMessageContextEntry[] = [],
  commandName = 'ask',
  source: 'slash-command' | 'natural-language' | 'slash-text' = 'natural-language',
): string {
  return formatDiscordInstructionEnvelope(
    createDiscordInstructionEnvelope({
      currentInstruction: instruction,
      commandName,
      source,
      contextHistory,
    }),
  );
}

export function adaptDiscordMessageContextEntry(
  message: Message,
  observedAt: Date = new Date(),
): DiscordMessageContextEntry {
  const validated = validateIpcIngress<DiscordMessageCreateIngress>(
    message,
    assertDiscordMessageCreateIngress,
  );
  return {
    ...(validated.id === undefined ? {} : { messageId: validated.id }),
    ...(validated.channelId === undefined || validated.channelId === null
      ? {}
      : { channelId: validated.channelId }),
    ...(validated.guildId === undefined || validated.guildId === null
      ? {}
      : { guildId: validated.guildId }),
    authorId: validated.author.id,
    authorIsBot: validated.author.bot === true,
    content: validated.content,
    timestamp:
      validated.createdTimestamp === undefined
        ? observedAt.toISOString()
        : new Date(validated.createdTimestamp).toISOString(),
  };
}

export class DiscordMessageContextHistory {
  private readonly entries: DiscordMessageContextEntry[] = [];

  constructor(private readonly maxEntries = 200) {}

  append(entry: DiscordMessageContextEntry): void {
    if (entry.messageId !== undefined) {
      const duplicateIndex = this.entries.findIndex(
        (existing) => existing.messageId === entry.messageId,
      );
      if (duplicateIndex >= 0) {
        this.entries[duplicateIndex] = entry;
        return;
      }
    }

    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  appendMany(entries: readonly DiscordMessageContextEntry[]): void {
    for (const entry of entries) {
      this.append(entry);
    }
  }

  snapshot(
    channelId: string | undefined,
    limit = 20,
  ): readonly DiscordMessageContextEntry[] {
    const entries =
      channelId === undefined
        ? this.entries
        : this.entries.filter((entry) => entry.channelId === channelId);
    return entries.slice(-Math.max(0, limit));
  }
}

function extractFetchedDiscordMessages(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (
    typeof value === 'object' &&
    'values' in value &&
    typeof value.values === 'function'
  ) {
    const values = (
      value as { values: () => Iterable<unknown> }
    ).values();
    return Array.from(values);
  }
  return [];
}

async function fetchDiscordMessageContextBackfill(
  message: Message,
  limit: number,
): Promise<DiscordMessageContextEntry[]> {
  if (limit <= 0) {
    return [];
  }

  const channel = (message as unknown as {
    channel?: {
      messages?: {
        fetch?: (options: { limit: number }) => Promise<unknown>;
      };
    };
  }).channel;
  const messagesManager = channel?.messages;
  if (typeof messagesManager?.fetch !== 'function') {
    return [];
  }

  const fetched = await messagesManager.fetch({ limit });
  return extractFetchedDiscordMessages(fetched)
    .flatMap((rawMessage) => {
      try {
        return [adaptDiscordMessageContextEntry(rawMessage as Message)];
      } catch {
        return [];
      }
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.timestamp);
      const rightTime = Date.parse(right.timestamp);
      return leftTime - rightTime;
    });
}

export function extractNaturalLanguageAskInstruction(
  content: string,
  botUserId: string,
  options: NaturalLanguageMessageOptions = {},
): string | undefined {
  const mentionPattern = new RegExp(
    `^\\s*${NATURAL_LANGUAGE_LEADING_ATTENTION}<@!?${escapeRegExp(botUserId)}>${naturalLanguageAddressSuffixPattern()}`,
    'iu',
  );
  const mentionMatch = content.match(mentionPattern);
  if (mentionMatch) {
    return normalizeNaturalLanguageAskInstruction(
      content.slice(mentionMatch[0].length),
    );
  }

  if (options.allowNonLeadingMentions === true) {
    const nonLeadingMentionInstruction = extractNonLeadingMentionInstruction(
      content,
      botUserId,
    );
    if (nonLeadingMentionInstruction !== undefined) {
      return nonLeadingMentionInstruction;
    }
  }

  if ((options.triggerMode ?? 'mention') === 'mention') {
    return undefined;
  }

  const prefixes = sortedNaturalLanguagePrefixes(options.prefixes ?? []);
  for (const prefix of prefixes) {
    const prefixPattern = new RegExp(
      `^\\s*${NATURAL_LANGUAGE_LEADING_ATTENTION}${escapeRegExp(prefix)}${naturalLanguageAddressSuffixPattern()}`,
      'iu',
    );
    const prefixMatch = content.match(prefixPattern);
    if (!prefixMatch) {
      continue;
    }
    return normalizeNaturalLanguageAskInstruction(
      content.slice(prefixMatch[0].length),
    );
  }

  return undefined;
}

export interface NaturalLanguageControlIntent {
  readonly commandName: Exclude<DiscordFirstSliceCommandName, 'ask'>;
  readonly taskId?: string;
  readonly reason?: string;
  readonly state?:
    | 'accepted'
    | 'running'
    | 'terminal'
    | 'active'
    | 'all'
    | 'archived';
  readonly action?:
    | 'list'
    | 'add'
    | 'done'
    | 'cadence'
    | 'allow_guild'
    | 'revoke_guild'
    | 'allow_user'
    | 'revoke_user'
    | 'allow_channel'
    | 'revoke_channel'
    | 'add_admin'
    | 'remove_admin';
  readonly status?: 'open' | 'done' | 'all';
  readonly itemId?: string;
  readonly text?: string;
  readonly subjectId?: string;
  readonly approvalId?: string;
  readonly note?: string;
  readonly limit?: string;
  readonly historyView?: 'events' | 'talk';
  readonly since?: string;
  readonly feedKind?: 'all' | 'task' | 'escalation' | 'approval';
}

function extractDiscordTaskId(content: string): string | undefined {
  return content.match(DISCORD_TASK_ID_PATTERN)?.[0];
}

const RESEARCH_AGENDA_ID_PATTERN = /\bresearch-agenda-[A-Za-z0-9_-]+\b/u;

function extractResearchAgendaId(content: string): string | undefined {
  return content.match(RESEARCH_AGENDA_ID_PATTERN)?.[0];
}

function normalizeNaturalLanguageAgendaText(instruction: string): string {
  return instruction
    .replace(RESEARCH_AGENDA_ID_PATTERN, ' ')
    .replace(
      /\b(?:agenda|cadence|remember|track|add|done|complete|completed)\b/giu,
      ' ',
    )
    .replace(
      /(?:연구|어젠다|아젠다|계획|후속|주기|리듬|등록|추가|기억|기록|완료|끝났|끝낸|설정|처리|해줘|해주세요|으로|로|에|은|는|을|를)/gu,
      ' ',
    )
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeNaturalLanguageArchiveReason(
  instruction: string,
): string | undefined {
  const reason = instruction
    .replace(DISCORD_TASK_ID_PATTERN, ' ')
    .replace(/\b(?:archive|archived|hide|close|dismiss)\b/giu, ' ')
    .replace(/(?:아카이브|보관|숨겨|숨김|닫아|정리|처리|해줘|해주세요|으로|로|에|은|는|을|를)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return reason.length === 0 ? undefined : reason;
}

function normalizeNaturalLanguageUnarchiveReason(
  instruction: string,
): string | undefined {
  const reason = instruction
    .replace(DISCORD_TASK_ID_PATTERN, ' ')
    .replace(/\b(?:unarchive|restore|restored|unhide|reopen)\b/giu, ' ')
    .replace(
      /(?:아카이브|보관|숨김|해제|복원|되돌려|다시|보여|열어|처리|해줘|해주세요|으로|로|에|은|는|을|를)/gu,
      ' ',
    )
    .replace(/\s+/gu, ' ')
    .trim();
  return reason.length === 0 ? undefined : reason;
}

function normalizeNaturalLanguageRerunNote(
  instruction: string,
): string | undefined {
  const note = instruction
    .replace(DISCORD_TASK_ID_PATTERN, ' ')
    .replace(/\b(?:rerun|retry|re-run|restart|repeat|again)\b/giu, ' ')
    .replace(
      /(?:재실행|다시\s*실행|다시\s*돌려|재시도|반복|한\s*번\s*더|다시|실행|돌려|해줘|해주세요|으로|로|에|은|는|을|를)/gu,
      ' ',
    )
    .replace(/\s+/gu, ' ')
    .trim();
  return note.length === 0 ? undefined : note;
}

function normalizeNaturalLanguageEscalationReason(
  instruction: string,
): string | undefined {
  const reason = instruction
    .replace(DISCORD_TASK_ID_PATTERN, ' ')
    .replace(/\/+/gu, ' ')
    .replace(
      /\b(?:escalate|escalation|handoff)\b/giu,
      ' ',
    )
    .replace(
      /(?:에스컬레이션|에스컬레이트|해줘|해주세요|으로|로|에|은|는|을|를)/gu,
      ' ',
    )
    .replace(/\s+/gu, ' ')
    .trim();
  return reason.length === 0 ? undefined : reason;
}

function extractNaturalLanguageLimit(content: string): string | undefined {
  const english = content.match(
    /\b(?:last|latest|recent|limit|show)\s+(?<limit>\d{1,2})\b/iu,
  )?.groups?.limit;
  if (english !== undefined) {
    return english;
  }
  const korean = content.match(
    /(?:최근|마지막|최신)\s*(?<limit>\d{1,2})\s*(?:개|건)?/u,
  )?.groups?.limit;
  if (korean !== undefined) {
    return korean;
  }
  return content.match(/\b(?<limit>\d{1,2})\s*$/u)?.groups?.limit;
}

function extractNaturalLanguageFeedSince(content: string): string | undefined {
  return content.match(/\b(?<since>\d{1,4}\s*[smhd])\b/iu)?.groups?.since
    ?.replace(/\s+/gu, '')
    .toLowerCase();
}

function classifyNaturalLanguageFeedKind(
  instruction: string,
  normalized: string,
): 'all' | 'task' | 'escalation' | 'approval' {
  if (/\b(?:escalation|escalate)\b/u.test(normalized) || /(?:에스컬레이션|운영자)/u.test(instruction)) {
    return 'escalation';
  }
  if (/\bapproval\b/u.test(normalized) || /(?:승인)/u.test(instruction)) {
    return 'approval';
  }
  if (/\btask\b/u.test(normalized) || /(?:태스크|작업)/u.test(instruction)) {
    return 'task';
  }
  return 'all';
}

const DISCORD_NUMERIC_ID_PATTERN = /\b\d{15,22}\b/u;
const CONTROL_APPROVAL_ID_PATTERN = /\b[A-Za-z0-9][A-Za-z0-9_.:-]{2,}\b/u;
const CONTROL_APPROVAL_ID_PATTERN_SOURCE =
  String.raw`\b[A-Za-z0-9][A-Za-z0-9_.:-]{2,}\b`;
const APPROVAL_ID_STOP_WORDS = new Set([
  'approve',
  'approval',
  'approved',
  'auth',
  'authorization',
  'can',
  'could',
  'deny',
  'denied',
  'for',
  'id',
  'kindly',
  'permission',
  'permissions',
  'please',
  'request',
  'reject',
  'rejected',
  'that',
  'the',
  'this',
  'user',
  'would',
  'you',
  '승인',
  '거부',
  '반려',
  '처리',
  '해줘',
  '해주세요',
]);

function extractDiscordNumericId(content: string): string | undefined {
  return content.match(DISCORD_NUMERIC_ID_PATTERN)?.[0];
}

function extractApprovalIdNearDecisionTerm(content: string): string | undefined {
  const englishAfter = content.match(
    new RegExp(
      String.raw`\b(?:approve|approved|deny|denied|reject|rejected)\b` +
        String.raw`(?:\s+(?:the|this|that|request|approval|approval[_\s-]?id|id|please|kindly))*` +
        String.raw`\s+(?<approvalId>${CONTROL_APPROVAL_ID_PATTERN_SOURCE})`,
      'iu',
    ),
  )?.groups?.approvalId;
  if (englishAfter !== undefined) {
    return englishAfter;
  }

  const englishBefore = content.match(
    new RegExp(
      String.raw`(?<approvalId>${CONTROL_APPROVAL_ID_PATTERN_SOURCE})` +
        String.raw`\s+(?:approve|approved|deny|denied|reject|rejected)\b`,
      'iu',
    ),
  )?.groups?.approvalId;
  if (englishBefore !== undefined) {
    return englishBefore;
  }

  return content.match(
    new RegExp(
      String.raw`(?:승인|허가|거부|반려|불허)` +
        String.raw`(?:\s*(?:요청|결재|아이디|id))*` +
        String.raw`\s*(?<approvalId>${CONTROL_APPROVAL_ID_PATTERN_SOURCE})`,
      'iu',
    ),
  )?.groups?.approvalId;
}

function extractApprovalId(content: string): string | undefined {
  const explicit = content.match(
    /(?:approval[_\s-]?id|approval|승인\s*id|결재\s*id)\s*[:=]?\s*(?<approvalId>[A-Za-z0-9][A-Za-z0-9_.:-]{2,})/iu,
  )?.groups?.approvalId;
  if (explicit !== undefined) {
    return explicit;
  }
  const nearDecisionTerm = extractApprovalIdNearDecisionTerm(content);
  if (nearDecisionTerm !== undefined) {
    return nearDecisionTerm;
  }
  for (const match of content.matchAll(
    new RegExp(CONTROL_APPROVAL_ID_PATTERN, 'gu'),
  )) {
    const candidate = match[0];
    if (!APPROVAL_ID_STOP_WORDS.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return undefined;
}

function classifyNaturalLanguageApprovalIntent(
  instruction: string,
  normalized: string,
): NaturalLanguageControlIntent | undefined {
  const isApprove =
    /\b(?:approve|approved)\b/u.test(normalized) || /(?:승인|허가)/u.test(instruction);
  const isDeny =
    /\b(?:deny|denied|reject|rejected)\b/u.test(normalized) ||
    /(?:거부|반려|불허)/u.test(instruction);
  if (isApprove === isDeny) {
    return undefined;
  }

  const approvalId = extractApprovalId(instruction);
  if (approvalId === undefined) {
    return undefined;
  }

  return isApprove
    ? {
        commandName: 'approve',
        approvalId,
        note: 'approved from natural-language Discord message',
      }
    : {
        commandName: 'deny',
        approvalId,
        reason: 'denied from natural-language Discord message',
      };
}

function classifyRawAuthAction(
  normalized: string,
):
  | 'list'
  | 'allow_guild'
  | 'revoke_guild'
  | 'allow_user'
  | 'revoke_user'
  | 'allow_channel'
  | 'revoke_channel'
  | 'add_admin'
  | 'remove_admin'
  | undefined {
  if (/\blist\b/u.test(normalized)) {
    return 'list';
  }
  if (/\ballow_guild\b/u.test(normalized)) {
    return 'allow_guild';
  }
  if (/\brevoke_guild\b/u.test(normalized)) {
    return 'revoke_guild';
  }
  if (/\ballow_user\b/u.test(normalized)) {
    return 'allow_user';
  }
  if (/\brevoke_user\b/u.test(normalized)) {
    return 'revoke_user';
  }
  if (/\ballow_channel\b/u.test(normalized)) {
    return 'allow_channel';
  }
  if (/\brevoke_channel\b/u.test(normalized)) {
    return 'revoke_channel';
  }
  if (/\badd_admin\b/u.test(normalized)) {
    return 'add_admin';
  }
  if (/\bremove_admin\b/u.test(normalized)) {
    return 'remove_admin';
  }
  return undefined;
}

function classifyNaturalLanguageAuthIntent(
  instruction: string,
  normalized: string,
): NaturalLanguageControlIntent | undefined {
  const rawAction = classifyRawAuthAction(normalized);
  if (
    rawAction === 'list' ||
    (rawAction === undefined &&
      (/\b(?:list|show)\b/u.test(normalized) || /(?:목록|조회|보여)/u.test(instruction))
    )
  ) {
    const mentionsAuthList =
      /\b(?:auth|authorization|permission|permissions|access|allowlist)\b/u.test(
        normalized,
      ) || /(?:인증|권한|접근\s*권한|허용\s*목록|관리자)/u.test(instruction);
    if (mentionsAuthList) {
      return { commandName: 'auth', action: 'list' };
    }
  }

  const subjectId = extractDiscordNumericId(instruction);
  if (subjectId === undefined) {
    return undefined;
  }
  if (rawAction !== undefined) {
    return {
      commandName: 'auth',
      action: rawAction,
      subjectId,
    };
  }

  const isAdd =
    /\b(?:allow|grant|add)\b/u.test(normalized) ||
    /(?:허용|허가|추가|부여|승격)/u.test(instruction);
  const isRemove =
    /\b(?:revoke|remove|deny|block)\b/u.test(normalized) ||
    /(?:불허|해제|제거|회수|차단|강등)/u.test(instruction);
  if (isAdd === isRemove) {
    return undefined;
  }

  const scope =
    /\b(?:admin|administrator)\b/u.test(normalized) || /(?:관리자)/u.test(instruction)
      ? 'admin'
      : /\b(?:guild|server)\b/u.test(normalized) || /(?:길드|서버)/u.test(instruction)
        ? 'guild'
        : /\bchannel\b/u.test(normalized) || /(?:채널)/u.test(instruction)
          ? 'channel'
          : /\buser\b/u.test(normalized) || /(?:사용자|유저)/u.test(instruction)
            ? 'user'
            : undefined;
  if (scope === undefined) {
    return undefined;
  }

  const mentionsAuth =
    /\b(?:auth|authorization|permission|permissions|access|allowlist)\b/u.test(
      normalized,
    ) ||
    /(?:인증|권한|접근\s*권한|허용\s*목록|관리자)/u.test(instruction) ||
    rawAction !== undefined ||
    /\b(?:allow|grant|revoke|remove|deny|block)\b/u.test(normalized) ||
    /(?:허용|허가|불허|해제|제거|회수|차단|부여|승격|강등)/u.test(instruction);
  if (!mentionsAuth) {
    return undefined;
  }

  const action =
    scope === 'admin'
      ? isAdd
        ? 'add_admin'
        : 'remove_admin'
      : scope === 'guild'
        ? isAdd
          ? 'allow_guild'
          : 'revoke_guild'
        : scope === 'channel'
          ? isAdd
            ? 'allow_channel'
            : 'revoke_channel'
          : isAdd
            ? 'allow_user'
            : 'revoke_user';

  return {
    commandName: 'auth',
    action,
    subjectId,
  };
}

function classifyNaturalLanguageTaskListState(
  instruction: string,
  normalized: string,
): 'accepted' | 'running' | 'terminal' | 'active' | 'all' | 'archived' {
  if (
    /\b(?:archived|archive)\b/u.test(normalized) ||
    /(?:아카이브|보관|숨김)/u.test(instruction)
  ) {
    return 'archived';
  }
  if (/\b(?:all|every)\b/u.test(normalized) || /(?:전체|모든)/u.test(instruction)) {
    return 'all';
  }
  if (
    /\b(?:done|finished|terminal|completed)\b/u.test(normalized) ||
    /(?:완료|끝난|종료|터미널)/u.test(instruction)
  ) {
    return 'terminal';
  }
  if (/\baccepted\b/u.test(normalized) || /(?:접수|수락)/u.test(instruction)) {
    return 'accepted';
  }
  if (
    /\b(?:running|progress|active|current|ongoing)\b/u.test(normalized) ||
    /(?:진행\s*중|진행중|현재|활성|실행\s*중|실행중)/u.test(instruction)
  ) {
    return 'active';
  }
  return 'all';
}

function mentionsNaturalLanguageResearchWork(
  instruction: string,
  normalized: string,
): boolean {
  return (
    /\b(?:research|investigate|analy[sz]e|survey|literature|benchmark|evaluate|verify|experiment)\b/u.test(
      normalized,
    ) ||
    /(?:리서치|조사|연구|분석|문헌|벤치마크|평가|검증|실험)/u.test(instruction)
  );
}

function mentionsNaturalLanguageTraitDiscovery(
  instruction: string,
  normalized: string,
): boolean {
  const hasTraitTerm =
    /\b(?:traits?|trait\s+modules?|plugins?|skills?|modules?)\b/u.test(
      normalized,
    ) ||
    /(?:트레이트|플러그인|스킬|모듈)/u.test(instruction);
  if (!hasTraitTerm) {
    return false;
  }
  const compactInstruction = instruction.trim();
  if (
    /^(?:traits?|trait\s+modules?|plugins?|skills?|modules?)$/u.test(
      normalized.trim(),
    ) ||
    /^(?:트레이트|플러그인|스킬|모듈)(?:\s*목록)?$/u.test(compactInstruction)
  ) {
    return true;
  }
  return (
    /\b(?:list|show|discover|available|installed|inspect|registry)\b/u.test(
      normalized,
    ) ||
    /(?:목록|보여|나열|조회|확인|사용\s*가능|설치된|레지스트리)/u.test(
      instruction,
    )
  );
}

function mentionsNaturalLanguageEscalationRequest(
  taskId: string | undefined,
  instruction: string,
  normalized: string,
): boolean {
  if (/\b(?:escalate|escalation|human review|handoff)\b/u.test(normalized)) {
    return true;
  }
  if (
    /\b(?:(?:needs?|request|ask|notify|alert|route|send|pass|hand\s*off)\s+(?:this\s+)?(?:to\s+)?(?:an?\s+|the\s+)?operator|operator\s+(?:review|handoff|attention|escalation|help))\b/u.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /(?:에스컬레이션|에스컬레이트|사람(?:에게)?\s*넘겨|수동\s*검토)/u.test(
      instruction,
    )
  ) {
    return true;
  }
  if (
    /(?:운영자|담당자).{0,16}(?:검토\s*요청|검토|확인|넘겨|전달)/u.test(
      instruction,
    )
  ) {
    return true;
  }
  return taskId !== undefined && /(?:검토\s*요청)/u.test(instruction);
}

export function classifyNaturalLanguageControlIntent(
  instruction: string,
): NaturalLanguageControlIntent | undefined {
  const taskId = extractDiscordTaskId(instruction);
  const agendaId = extractResearchAgendaId(instruction);
  const normalized = instruction.toLowerCase();
  const limit = extractNaturalLanguageLimit(instruction);

  if (
    /\bhelp\b/u.test(normalized) ||
    /(?:도움말|도움|사용법|어떻게\s*요청|무엇을\s*할\s*수|뭘\s*할\s*수)/u.test(
      instruction,
    )
  ) {
    return { commandName: 'help' };
  }

  const authIntent = classifyNaturalLanguageAuthIntent(instruction, normalized);
  if (authIntent !== undefined) {
    return authIntent;
  }

  const approvalIntent = classifyNaturalLanguageApprovalIntent(
    instruction,
    normalized,
  );
  if (approvalIntent !== undefined) {
    return approvalIntent;
  }

  if (
    taskId !== undefined &&
    (/\b(?:rerun|retry|re-run|restart|repeat)\b/u.test(normalized) ||
      /(?:재실행|다시\s*실행|다시\s*돌려|재시도|한\s*번\s*더|반복)/u.test(
        instruction,
      ))
  ) {
    return {
      commandName: 'rerun',
      taskId,
      note: normalizeNaturalLanguageRerunNote(instruction),
    };
  }

  if (
    taskId !== undefined &&
    (/\b(?:unarchive|restore|unhide|reopen)\b/u.test(normalized) ||
      /(?:아카이브\s*해제|보관\s*해제|숨김\s*해제|복원|되돌려|다시\s*보여)/u.test(
        instruction,
      ))
  ) {
    return {
      commandName: 'unarchive',
      taskId,
      reason: normalizeNaturalLanguageUnarchiveReason(instruction),
    };
  }

  if (
    taskId !== undefined &&
    (/\b(?:archive|hide|close|dismiss)\b/u.test(normalized) ||
      /(?:아카이브|보관|숨겨|숨김|닫아|정리)/u.test(instruction))
  ) {
    return {
      commandName: 'archive',
      taskId,
      reason: normalizeNaturalLanguageArchiveReason(instruction),
    };
  }

  if (
    taskId !== undefined &&
    (/\b(?:focus|bind|continue)\b/u.test(normalized) ||
      /(?:포커스|집중|이어|계속|바인딩|묶어)/u.test(instruction))
  ) {
    return {
      commandName: 'focus',
      taskId,
    };
  }

  if (
    /\b(?:unfocus|release focus|clear focus|unbind)\b/u.test(normalized) ||
    /(?:포커스\s*해제|집중\s*해제|바인딩\s*해제|풀어)/u.test(instruction)
  ) {
    return { commandName: 'unfocus' };
  }

  if (
    /^\/?feed\b/u.test(normalized.trim()) ||
    /(?:컨트롤\s*피드|이벤트\s*피드|원장\s*피드)/u.test(instruction)
  ) {
    return {
      commandName: 'feed',
      since: extractNaturalLanguageFeedSince(instruction),
      feedKind: classifyNaturalLanguageFeedKind(instruction, normalized),
    };
  }

  if (mentionsNaturalLanguageEscalationRequest(taskId, instruction, normalized)) {
    return {
      commandName: 'escalate',
      ...(taskId === undefined ? {} : { taskId }),
      reason:
        normalizeNaturalLanguageEscalationReason(instruction) ??
        'operator escalation requested from natural-language Discord message',
    };
  }

  if (
    taskId !== undefined &&
    (/\b(?:cancel|stop|abort)\b/u.test(normalized) ||
      /(?:취소|중단|멈춰|멈추|정지)/u.test(instruction))
  ) {
    return {
      commandName: 'cancel',
      taskId,
      reason: 'cancel requested from natural-language Discord message',
    };
  }

  if (
    taskId !== undefined &&
    (/\b(?:context|prompt|envelope)\b/u.test(normalized) ||
      /(?:컨텍스트|맥락|문맥|프롬프트|봉투|인스트럭션)/u.test(instruction))
  ) {
    return {
      commandName: 'context',
      taskId,
    };
  }

  const wantsHistory =
    /\b(?:history|timeline|ledger|log|events?)\b/u.test(normalized) ||
    /(?:히스토리|기록|이력|내역|로그|타임라인)/u.test(instruction);
  if (wantsHistory) {
    const historyView =
      /\b(?:--talk|talk|conversation|chat|transcript|messages?)\b/u.test(
        normalized,
      ) || /(?:대화록|대화|채팅|메시지)/u.test(instruction)
        ? 'talk'
        : undefined;
    return {
      commandName: 'history',
      ...(taskId === undefined ? {} : { taskId }),
      ...(limit === undefined ? {} : { limit }),
      ...(historyView === undefined ? {} : { historyView }),
    };
  }

  if (
    taskId !== undefined &&
    (/\b(?:status|progress|state|check)\b/u.test(normalized) ||
      /(?:상태|진행|완료|확인|어떻게\s*됐|어떻게\s*되었|조회)/u.test(
        instruction,
      ))
  ) {
    return {
      commandName: 'status',
      taskId,
    };
  }

  if (
    !mentionsNaturalLanguageResearchWork(instruction, normalized) &&
    (/\b(?:doctor|health|readiness|diagnostic|diagnostics)\b/u.test(normalized) ||
      /(?:진단|헬스|상태\s*점검|서비스\s*상태|준비\s*상태)/u.test(instruction))
  ) {
    return { commandName: 'doctor' };
  }

  if (mentionsNaturalLanguageTraitDiscovery(instruction, normalized)) {
    return { commandName: 'traits' };
  }

  if (
    /\b(?:agenda|cadence)\b/u.test(normalized) ||
    /(?:어젠다|아젠다|후속\s*계획|연구\s*계획|주기|리듬)/u.test(instruction) ||
    agendaId !== undefined
  ) {
    if (
      /\b(?:cadence|rhythm|schedule)\b/u.test(normalized) ||
      /(?:주기|리듬|정기|매일|매주)/u.test(instruction)
    ) {
      return {
        commandName: 'agenda',
        action: 'cadence',
        text: normalizeNaturalLanguageAgendaText(instruction),
      };
    }
    if (
      agendaId !== undefined &&
      (/\b(?:done|complete|completed|close)\b/u.test(normalized) ||
        /(?:완료|끝났|끝낸|닫아|종료)/u.test(instruction))
    ) {
      return {
        commandName: 'agenda',
        action: 'done',
        itemId: agendaId,
      };
    }
    if (
      /\b(?:add|remember|track|note|todo)\b/u.test(normalized) ||
      /(?:등록|추가|기억|기록|넣어|남겨)/u.test(instruction)
    ) {
      return {
        commandName: 'agenda',
        action: 'add',
        text: normalizeNaturalLanguageAgendaText(instruction),
      };
    }
    return {
      commandName: 'agenda',
      action: 'list',
      status:
        /\b(?:done|completed)\b/u.test(normalized) || /(?:완료|끝난)/u.test(instruction)
          ? 'done'
          : 'open',
      ...(limit === undefined ? {} : { limit }),
    };
  }

  if (
    /\b(?:tasks|queue|list|agenda)\b/u.test(normalized) ||
    /(?:작업\s*목록|태스크\s*목록|목록|큐|대기열|어젠다|진행\s*중인\s*연구|연구\s*목록)/u.test(
      instruction,
    )
  ) {
    return {
      commandName: 'tasks',
      state: classifyNaturalLanguageTaskListState(instruction, normalized),
      ...(limit === undefined ? {} : { limit }),
    };
  }

  if (
    mentionsNaturalLanguageResearchWork(instruction, normalized)
  ) {
    return { commandName: 'research' };
  }

  return undefined;
}

export function extractSlashTextControlInstruction(
  content: string,
): string | undefined {
  const match = content.match(
    /^\s*\/(?<command>status|cancel|rerun|archive|unarchive|tasks|traits|agenda|history|context|escalate|feed|approve|deny|doctor|subagents|focus|unfocus|auth|help)(?:\s+(?<rest>[\s\S]*?)\s*)?$/iu,
  );
  const command = match?.groups?.command?.toLowerCase();
  if (command === undefined) {
    return undefined;
  }

  const rest = match?.groups?.rest?.trim() ?? '';
  return rest.length === 0 ? command : `${command} ${rest}`;
}

export function extractNaturalLanguagePrefixInstruction(
  content: string,
  botUserId: string,
  prefixes: readonly string[] = [],
): string | undefined {
  const leadingMention = new RegExp(
    `^\\s*${NATURAL_LANGUAGE_LEADING_ATTENTION}<@!?${escapeRegExp(botUserId)}>`,
    'iu',
  );
  if (leadingMention.test(content)) {
    return undefined;
  }
  return extractNaturalLanguageAskInstruction(content, botUserId, {
    prefixes,
    triggerMode: 'mention-or-prefix',
  });
}

/**
 * P3-def-2: translate the DiscordMessagePayload contract (used across
 * the renderer + command-handler boundary) into the wire shape that
 * discord.js's `reply`, `editReply`, and `followUp` accept.
 *
 * - `content` and `allowedMentions` pass through unchanged (existing
 *   behaviour preserved).
 * - When `attachments` is present and non-empty, each `{ name, path }`
 *   is materialized into a discord.js `AttachmentBuilder` whose source
 *   is the on-disk path. discord.js reads the file lazily when the
 *   message is sent — no preemptive read, only built-in node modules
 *   on the discord.js side.
 *
 * Returning a plain object keeps the helper independent of the specific
 * discord.js method (reply/editReply/followUp all accept this shape).
 */
function toDiscordJsButtonStyle(style: DiscordButtonStyle): ButtonStyle {
  switch (style) {
    case 'primary':
      return ButtonStyle.Primary;
    case 'success':
      return ButtonStyle.Success;
    case 'danger':
      return ButtonStyle.Danger;
    case 'secondary':
    default:
      return ButtonStyle.Secondary;
  }
}

export function toDiscordJsPayload(
  payload: DiscordMessagePayload,
): Record<string, unknown> {
  const out: Record<string, unknown> = { content: payload.content };
  if (payload.allowedMentions !== undefined) {
    out['allowedMentions'] = payload.allowedMentions;
  }
  if (payload.attachments !== undefined && payload.attachments.length > 0) {
    out['files'] = payload.attachments.map((attachment) =>
      new AttachmentBuilder(attachment.path, { name: attachment.name }),
    );
  }
  // UX-14 (cycle 7): translate transport-agnostic component descriptors
  // into discord.js ActionRowBuilder<ButtonBuilder>. The renderer caps
  // rows + buttons-per-row to Discord's API limits already.
  if (payload.components !== undefined && payload.components.length > 0) {
    out['components'] = payload.components.map((row) => {
      const builder = new ActionRowBuilder<ButtonBuilder>();
      for (const component of row.components) {
        builder.addComponents(
          new ButtonBuilder()
            .setCustomId(component.customId)
            .setLabel(component.label)
            .setStyle(toDiscordJsButtonStyle(component.style)),
        );
      }
      return builder;
    });
  }
  return out;
}

/**
 * UX-14 (cycle 7): parse the customId of a `/subagents` button press
 * and synthesize a `DiscordCommandInteractionAdapter` shaped exactly
 * like a slash-command invocation, so the existing `handleSubagents`
 * dispatches without any new branch.
 *
 * Custom-id format: `subagents:<verb>:<subagentId>`.
 *   - `<verb>` is `kill` or `log` (the only two button verbs we mint
 *     today).
 *   - `<subagentId>` rides as the `target` option, mirroring the
 *     slash form `/subagents action:kill target:<id>`.
 *
 * Returns `undefined` if the customId does not match the namespace
 * or has an unsupported verb — the bot's listener silently ignores
 * those rather than throwing, mirroring the slash-command code path.
 */
export function adaptSubagentButtonInteraction(
  interaction: ButtonInteraction,
): DiscordCommandInteractionAdapter | undefined {
  const customId = interaction.customId;
  if (!customId.startsWith('subagents:')) {
    return undefined;
  }
  const parts = customId.split(':');
  if (parts.length !== 3) {
    return undefined;
  }
  const verb = parts[1];
  const subagentId = parts[2];
  if (verb !== 'kill' && verb !== 'log') {
    return undefined;
  }
  if (subagentId === undefined || subagentId.length === 0) {
    return undefined;
  }
  const options = new Map<string, string>([
    ['action', verb],
    ['target', subagentId],
  ]);
  return {
    commandName: 'subagents',
    userId: interaction.user.id,
    channelId: interaction.channelId ?? undefined,
    guildId: interaction.guildId ?? undefined,
    source: 'slash-command',
    getString: (name) => options.get(name) ?? null,
    deferReply: (deferOptions) =>
      Promise.resolve(
        interaction.deferReply(
          deferOptions?.ephemeral === true
            ? { flags: MessageFlags.Ephemeral }
            : undefined,
        ),
      ),
    editReply: (payload) =>
      Promise.resolve(interaction.editReply(toDiscordJsPayload(payload))),
    followUp: (payload) =>
      Promise.resolve(interaction.followUp(toDiscordJsPayload(payload))),
  };
}

export function adaptChatInputInteraction(
  interaction: ChatInputCommandInteraction,
): DiscordCommandInteractionAdapter {
  const validated = validateIpcIngress<DiscordChatInputInteractionIngress>(
    interaction,
    assertDiscordChatInputInteractionIngress,
  );

  if (!isDiscordFirstSliceCommandName(validated.commandName)) {
    throw new Error(`Unsupported Discord command: ${validated.commandName}`);
  }

  return {
    commandName: validated.commandName,
    userId: validated.user.id,
    channelId: validated.channelId ?? undefined,
    guildId: validated.guildId ?? undefined,
    source: 'slash-command',
    getString: (name, required = false) =>
      validated.options.getString(name, required) as string | null,
    deferReply: (options) =>
      Promise.resolve(
        validated.deferReply(
          options?.ephemeral === true
            ? { flags: MessageFlags.Ephemeral }
            : undefined,
        ),
      ),
    editReply: (payload) =>
      Promise.resolve(validated.editReply(toDiscordJsPayload(payload))),
    followUp: (payload) =>
      Promise.resolve(validated.followUp(toDiscordJsPayload(payload))),
    // UX-24 (cycle 9): expose fetchReply → wrapped message handle so
    // the handler can start a per-task thread. Returns undefined when
    // the underlying interaction does not implement fetchReply (older
    // ingresses / fakes), so the handler falls back to channel-only
    // delivery silently.
    ...(typeof validated.fetchReply === 'function'
      ? {
          fetchReply: async (): Promise<
            DiscordTaskMessageHandle | null | undefined
          > => {
            const message = await Promise.resolve(validated.fetchReply!());
            return wrapDiscordMessageAsTaskHandle(message);
          },
        }
      : {}),
  };
}

interface DiscordJsThreadCreateOptions {
  readonly name: string;
  readonly autoArchiveDuration?: number;
}

interface DiscordJsMessageLike {
  startThread?(options: DiscordJsThreadCreateOptions): Promise<{
    readonly id: string;
    send(payload: unknown): Promise<unknown>;
  }>;
}

/**
 * UX-24 (cycle 9): wrap a discord.js Message in the transport-agnostic
 * `DiscordTaskMessageHandle` shape. Returns `undefined` when the
 * incoming object does not look like a startThread-capable message
 * (e.g. DM channels, ephemeral replies, partial fetches) so the
 * handler proceeds with channel-only delivery.
 */
export function wrapDiscordMessageAsTaskHandle(
  message: unknown,
): DiscordTaskMessageHandle | undefined {
  if (message === null || message === undefined) {
    return undefined;
  }
  const candidate = message as DiscordJsMessageLike;
  if (typeof candidate.startThread !== 'function') {
    return undefined;
  }
  return {
    startThread: async (options) => {
      const thread = await candidate.startThread!({
        name: options.name,
        autoArchiveDuration: options.autoArchiveDurationMinutes ?? 1_440,
      });
      return {
        id: thread.id,
        send: async (payload) =>
          thread.send(toDiscordJsPayload(payload)),
      };
    },
  };
}

export function adaptNaturalLanguageMessage(
  message: Message,
  botUserId: string,
  options: NaturalLanguageMessageOptions = {},
): DiscordCommandInteractionAdapter | undefined {
  const validated = validateIpcIngress<DiscordMessageCreateIngress>(
    message,
    assertDiscordMessageCreateIngress,
  );

  if (validated.author.bot === true || validated.author.id === botUserId) {
    return undefined;
  }

  const instruction = extractNaturalLanguageAskInstruction(
    validated.content,
    botUserId,
    options,
  );
  const slashTextControlInstruction =
    instruction === undefined
      ? extractSlashTextControlInstruction(validated.content)
      : undefined;
  const effectiveInstruction = instruction ?? slashTextControlInstruction;
  if (effectiveInstruction === undefined) {
    return undefined;
  }
  const controlIntent = classifyNaturalLanguageControlIntent(
    effectiveInstruction,
  );
  if (slashTextControlInstruction !== undefined && controlIntent === undefined) {
    return undefined;
  }
  const contextualInstruction = formatDiscordContextualInstruction(
    effectiveInstruction,
    options.contextHistory,
    controlIntent?.commandName ?? 'ask',
    slashTextControlInstruction === undefined
      ? options.source ?? 'natural-language'
      : 'slash-text',
  );

  return {
    commandName: controlIntent?.commandName ?? 'ask',
    userId: validated.author.id,
    channelId: validated.channelId ?? undefined,
    guildId: validated.guildId ?? undefined,
    authorIsBot: false,
    source:
      slashTextControlInstruction === undefined
        ? options.source ?? 'natural-language'
        : 'slash-text',
    getString: (name, required = false) => {
      if (controlIntent?.commandName === 'status') {
        if (name === 'task_id') {
          return controlIntent.taskId ?? null;
        }
      }
      if (
        controlIntent?.commandName === 'context' ||
        controlIntent?.commandName === 'history' ||
        controlIntent?.commandName === 'focus'
      ) {
        if (name === 'task_id') {
          return controlIntent.taskId ?? null;
        }
      }
      if (
        controlIntent?.commandName === 'tasks' ||
        controlIntent?.commandName === 'history'
      ) {
        if (name === 'limit') {
          return controlIntent.limit ?? null;
        }
      }
      if (controlIntent?.commandName === 'history') {
        if (name === 'view') {
          return controlIntent.historyView ?? null;
        }
      }
      if (controlIntent?.commandName === 'tasks') {
        if (name === 'state') {
          return controlIntent.state ?? null;
        }
      }
      if (controlIntent?.commandName === 'agenda') {
        if (name === 'action') {
          return controlIntent.action ?? 'list';
        }
        if (name === 'status') {
          return controlIntent.status ?? null;
        }
        if (name === 'item_id') {
          return controlIntent.itemId ?? null;
        }
        if (name === 'text') {
          return controlIntent.text ?? null;
        }
        if (name === 'limit') {
          return controlIntent.limit ?? null;
        }
      }
      if (controlIntent?.commandName === 'cancel') {
        if (name === 'task_id') {
          return controlIntent.taskId ?? null;
        }
        if (name === 'reason') {
          return controlIntent.reason ?? null;
        }
      }
      if (controlIntent?.commandName === 'escalate') {
        if (name === 'task_id') {
          return controlIntent.taskId ?? null;
        }
        if (name === 'reason') {
          return controlIntent.reason ?? null;
        }
      }
      if (controlIntent?.commandName === 'feed') {
        if (name === 'since') {
          return controlIntent.since ?? null;
        }
        if (name === 'kind') {
          return controlIntent.feedKind ?? null;
        }
      }
      if (controlIntent?.commandName === 'rerun') {
        if (name === 'task_id') {
          return controlIntent.taskId ?? null;
        }
        if (name === 'note') {
          return controlIntent.note ?? null;
        }
      }
      if (
        controlIntent?.commandName === 'archive' ||
        controlIntent?.commandName === 'unarchive'
      ) {
        if (name === 'task_id') {
          return controlIntent.taskId ?? null;
        }
        if (name === 'reason') {
          return controlIntent.reason ?? null;
        }
      }
      if (controlIntent?.commandName === 'approve') {
        if (name === 'approval_id') {
          return controlIntent.approvalId ?? null;
        }
        if (name === 'note') {
          return controlIntent.note ?? null;
        }
      }
      if (controlIntent?.commandName === 'deny') {
        if (name === 'approval_id') {
          return controlIntent.approvalId ?? null;
        }
        if (name === 'reason') {
          return controlIntent.reason ?? null;
        }
      }
      if (controlIntent?.commandName === 'auth') {
        if (name === 'action') {
          return controlIntent.action ?? null;
        }
        if (name === 'subject_id') {
          return controlIntent.subjectId ?? null;
        }
      }
      if (name === 'instruction') {
        return contextualInstruction;
      }
      if (required) {
        throw new Error(`Missing required natural-language field: ${name}`);
      }
      return null;
    },
    deferReply: () => Promise.resolve(undefined),
    // UX-23 / UX-24 (cycle 10): the natural-language adapter (mention
    // path) used to map both editReply and followUp to message.reply,
    // which always creates a NEW Discord message — defeating the
    // cycle-8 in-place lifecycle edit and giving the cycle-9 thread
    // nothing to anchor against. The mention path is the surface
    // operators actually use.
    //
    // The fix wraps the FIRST `editReply` payload in `message.reply(...)`
    // and then on subsequent `editReply`/`followUp` calls we
    // `firstMessage.edit(payload)` against the cached message handle.
    // This collapses the lifecycle to a single in-place updated
    // message in the channel (UX-23) and makes the message handle
    // available for `startThread(...)` (UX-24).
    //
    // discord.js semantics: `Message.reply(...)` returns the new
    // Message; `Message.edit(payload)` updates that same Message in
    // place; both reject when the bot lacks SEND_MESSAGES /
    // MANAGE_MESSAGES on the channel — the existing fail-open paths
    // log + continue.
    ...createNaturalLanguageReplyAdapter(validated),
  };
}

interface NaturalLanguageReplyTarget {
  reply(payload: unknown): Promise<unknown> | unknown;
}

interface NaturalLanguageDiscordMessageHandle {
  edit(payload: unknown): Promise<unknown> | unknown;
  startThread?(options: DiscordJsThreadCreateOptions): Promise<{
    readonly id: string;
    send(payload: unknown): Promise<unknown>;
  }>;
}

function createNaturalLanguageReplyAdapter(
  validated: NaturalLanguageReplyTarget,
): Pick<DiscordCommandInteractionAdapter, 'editReply' | 'followUp' | 'fetchReply'> {
  let firstMessage: NaturalLanguageDiscordMessageHandle | undefined;

  const sendOrEdit = async (
    payload: DiscordMessagePayload,
  ): Promise<unknown> => {
    if (firstMessage === undefined) {
      const sent = await Promise.resolve(
        validated.reply(toDiscordJsPayload(payload)),
      );
      // discord.js Message.reply returns the Message object itself.
      // We cache it as the in-place edit anchor; if the return shape
      // is unexpected, we leave firstMessage unset and the next call
      // falls back to another reply (legacy behavior — no in-place
      // collapse, but no crash either).
      if (
        sent !== null &&
        sent !== undefined &&
        typeof (sent as NaturalLanguageDiscordMessageHandle).edit === 'function'
      ) {
        firstMessage = sent as NaturalLanguageDiscordMessageHandle;
      }
      return sent;
    }
    try {
      return await Promise.resolve(
        firstMessage.edit(toDiscordJsPayload(payload)),
      );
    } catch (error) {
      // Fail-open: if the in-place edit cannot land (Discord 4xx,
      // missing permission, etc.), fall back to a fresh reply so the
      // operator at least sees the lifecycle update somewhere.
      console.warn(
        'discord-natural-language-edit-fallback',
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return Promise.resolve(validated.reply(toDiscordJsPayload(payload)));
    }
  };

  return {
    editReply: (payload) => sendOrEdit(payload),
    followUp: (payload) => sendOrEdit(payload),
    // UX-24 (cycle 10): expose the cached first reply as a thread-
    // capable handle. Returns undefined until the first reply has
    // landed (the handler calls fetchReply AFTER the initial editReply,
    // so by then the cache is populated for the mention path too).
    fetchReply: async () => wrapDiscordMessageAsTaskHandle(firstMessage),
  };
}

export interface StartDiscordFirstSliceBotOptions {
  token: string;
  applicationId: string;
  guildId?: string;
  arona: Arona;
  dispatcher: Dispatcher;
  requestFactoryOptions: DefaultDiscordTaskRequestFactoryOptions;
  taskRegistry?: DiscordTaskRegistry;
  controlLedger?: ControlPlaneLedgerPort;
  accessPolicy?: DiscordAccessPolicy;
  authDatabase?: DiscordAuthDatabase;
  approvalRegistry?: RuntimeApprovalRegistry;
  subagentOperator?: import('../runtime/subagent-operator.js').SubagentOperatorSurface;
  followController?: import('./discord-follow-controller.js').DiscordFollowController;
  sessionBindings?: import('./discord-session-binding.js').DiscordSessionBindingManager;
  traitModuleRegistry?: TraitModuleRegistry;
  traitModuleRegistryError?: string;
  traitUsageTelemetry?: TraitUsageTelemetryPort;
  personaTransformer?: import('../persona/persona-style-transformer.js').PersonaStyleTransformer;
  /**
   * Optional session-log thread router. When supplied, lifecycle followUp
   * deliveries are routed into a per-Task thread under a Discord text
   * channel instead of replying back to the source chat channel. See
   * specs/CURRENT/discord-session-log-thread.md.
   */
  sessionLogThreadRouter?: import('./discord-session-log-thread-router.js').DiscordSessionLogThreadRouter;
  client?: Client;
  clientOptions?: ClientOptions;
  registerCommandsOnStart?: boolean;
  enableNaturalLanguageMessages?: boolean;
  enableMessageContentIntent?: boolean;
  naturalLanguagePrefixes?: readonly string[];
  naturalLanguageTriggerMode?: 'mention' | 'mention-or-prefix';
  enableMessageContextHistory?: boolean;
  enableMessageContextHistoryBackfill?: boolean;
  enableNaturalLanguagePrefixNotice?: boolean;
  messageContextHistoryLimit?: number;
  messageContextHistoryMaxEntries?: number;
  messageContextHistoryBackfillLimit?: number;
  waitForReadyOnStart?: boolean;
  readyTimeoutMs?: number;
  lifecycleLogger?: DiscordBotLifecycleLogger;
  doctorStatus?: DiscordDoctorStatus;
  /**
   * Optional file path for the persona settings store consulted by `/config`.
   * Defaults to `runtime-state/persona-settings.json` when omitted.
   */
  personaSettingsPath?: string;
  /**
   * Optional in-memory persona settings provider shared with the runtime
   * driver. When supplied, `/config set` and `/config reset` synchronously
   * update this provider so the next `RuntimeDriver.run()` reads the new
   * model/effort/maxTurns without a service restart.
   */
  runtimePersonaSettingsProvider?: import('../runtime/runtime-persona-settings-provider.js').InMemoryRuntimePersonaSettingsProvider;
  /**
   * Set of providers the bootstrap successfully authenticated. When present,
   * `/config set persona:arona key:provider value:<v>` rejects values
   * outside this set so an unreachable provider intent never lands in the
   * persona-settings store (multi-provider-scope.md §1.4.0).
   */
  bootstrapAvailableProviders?: ReadonlySet<'codex' | 'claude-agent'>;
  /**
   * Bare RuntimeDriver for the `/research-plan` decomposition orchestrator.
   * When supplied, the command handler can dispatch decomposed plans without
   * touching AgentRuntime; when omitted, `/research-plan` rejects with a
   * clear "use the CLI" message.
   */
  researchPlanRuntimeDriver?: import('../contracts/runtime-driver.js').RuntimeDriver;
  /**
   * P4 Stage 4-6 Commit 3 — opt-in roster routing for `/research-plan`.
   * When BOTH the policy enforcer AND `researchPlanUseSubagentRoster: true`
   * are supplied, the Discord handler builds a per-dispatch
   * `SubagentRoster` for each `/research-plan` invocation. Default OFF.
   * Bootstrap flips it on via
   * `AUTO_ARCHIVE_DISCORD_RESEARCH_PLAN_USE_SUBAGENT_ROSTER=on`.
   */
  researchPlanSubagentPolicyEnforcer?: import('../runtime/subagent-policy-enforcer.js').SubagentPolicyEnforcer;
  researchPlanUseSubagentRoster?: boolean;
}

export type DiscordBotLifecycleLogger = (
  event: string,
  details: Readonly<Record<string, unknown>>,
) => void;

const DEFAULT_DISCORD_READY_TIMEOUT_MS = 30_000;

function logDiscordBotLifecycle(
  logger: DiscordBotLifecycleLogger | undefined,
  event: string,
  details: Readonly<Record<string, unknown>> = {},
): void {
  if (!logger) {
    return;
  }

  try {
    logger(event, details);
  } catch (error) {
    console.error(
      'discord-bot-lifecycle-logger-error',
      JSON.stringify({
        event,
        ...summarizeInteractionHandlerError(error),
      }),
    );
  }
}

function isDiscordClientReady(client: Client): boolean {
  if (typeof client.isReady === 'function' && client.isReady()) {
    return true;
  }

  return client.readyAt !== null;
}

async function waitForDiscordClientReady(
  client: Client,
  timeoutMs: number,
): Promise<void> {
  if (isDiscordClientReady(client)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      client.off(Events.ClientReady, onReady);
      client.off(Events.Error, onError);
      clearTimeout(timeout);
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onReady = (): void => {
      settle(resolve);
    };
    const onError = (error: unknown): void => {
      settle(() => {
        reject(
          error instanceof Error
            ? error
            : new Error(`Discord client emitted a startup error: ${String(error)}`),
        );
      });
    };
    const timeout = setTimeout(() => {
      settle(() => {
        reject(
          new Error(
            `Discord client did not become ready within ${timeoutMs}ms.`,
          ),
        );
      });
    }, timeoutMs);

    client.once(Events.ClientReady, onReady);
    client.once(Events.Error, onError);
  });
}

export interface StartedDiscordFirstSliceBot {
  client: Client;
  handlers: DiscordCommandHandlers;
  taskRegistry: DiscordTaskRegistry;
  stop(): Promise<void>;
}

export async function startDiscordFirstSliceBot(
  options: StartDiscordFirstSliceBotOptions,
): Promise<StartedDiscordFirstSliceBot> {
  const client =
    options.client ??
    new Client(
      options.clientOptions ?? {
        intents: [
          GatewayIntentBits.Guilds,
          ...(options.enableNaturalLanguageMessages
            ? [
                GatewayIntentBits.GuildMessages,
                ...(options.enableMessageContentIntent === true
                  ? [GatewayIntentBits.MessageContent]
                  : []),
              ]
            : []),
        ],
      },
    );
  const taskRegistry = options.taskRegistry ?? new DiscordTaskRegistry();
  const lifecycleLogger = options.lifecycleLogger;
  if (lifecycleLogger) {
    client.once(Events.ClientReady, (readyClient) => {
      logDiscordBotLifecycle(lifecycleLogger, 'client-ready', {
        userId: readyClient.user.id,
      });
    });
    client.on(Events.Error, (error) => {
      logDiscordBotLifecycle(lifecycleLogger, 'client-error', {
        ...summarizeInteractionHandlerError(error),
      });
    });
    client.on(Events.Warn, (warning) => {
      logDiscordBotLifecycle(lifecycleLogger, 'client-warn', {
        message: warning,
      });
    });
  }
  const handlers = new DiscordCommandHandlers({
    arona: options.arona,
    dispatcher: options.dispatcher,
    requestFactory: new DefaultDiscordTaskRequestFactory(options.requestFactoryOptions),
    taskRegistry,
    controlLedger: options.controlLedger,
    accessPolicy: options.accessPolicy,
    authDatabase: options.authDatabase,
    approvalRegistry: options.approvalRegistry,
    subagentOperator: options.subagentOperator,
    ...(options.followController === undefined
      ? {}
      : { followController: options.followController }),
    sessionBindings: options.sessionBindings,
    ...(options.traitModuleRegistry === undefined
      ? {}
      : { traitModuleRegistry: options.traitModuleRegistry }),
    ...(options.traitModuleRegistryError === undefined
      ? {}
      : { traitModuleRegistryError: options.traitModuleRegistryError }),
    ...(options.traitUsageTelemetry === undefined
      ? {}
      : { traitUsageTelemetry: options.traitUsageTelemetry }),
    doctorStatus: options.doctorStatus,
    ...(options.personaSettingsPath === undefined
      ? {}
      : { personaSettingsPath: options.personaSettingsPath }),
    ...(options.runtimePersonaSettingsProvider === undefined
      ? {}
      : { runtimePersonaSettingsProvider: options.runtimePersonaSettingsProvider }),
    ...(options.bootstrapAvailableProviders === undefined
      ? {}
      : { bootstrapAvailableProviders: options.bootstrapAvailableProviders }),
    ...(options.researchPlanRuntimeDriver === undefined
      ? {}
      : { researchPlanRuntimeDriver: options.researchPlanRuntimeDriver }),
    ...(options.researchPlanSubagentPolicyEnforcer === undefined
      ? {}
      : {
          researchPlanSubagentPolicyEnforcer:
            options.researchPlanSubagentPolicyEnforcer,
        }),
    ...(options.researchPlanUseSubagentRoster === undefined
      ? {}
      : {
          researchPlanUseSubagentRoster: options.researchPlanUseSubagentRoster,
        }),
    ...(options.personaTransformer === undefined
      ? {}
      : { personaTransformer: options.personaTransformer }),
    ...(options.sessionLogThreadRouter === undefined
      ? {}
      : { sessionLogThreadRouter: options.sessionLogThreadRouter }),
  });
  const messageContextHistory =
    options.enableMessageContextHistory === true
      ? new DiscordMessageContextHistory(options.messageContextHistoryMaxEntries)
      : undefined;

  client.on(Events.InteractionCreate, async (interaction) => {
    // UX-14 (cycle 7): button-press path. The renderer attaches
    // [Kill] / [Log] buttons to `/subagents list` replies; pressing
    // one fires a synthetic chat-input interaction at the existing
    // `handleSubagents` so the operator surface, persona, and ledger
    // all see the same shape they would have for the slash form.
    //
    // Guard against fakes that don't implement `isButton`: existing
    // tests stub the interaction shape with only `isChatInputCommand`,
    // so the optional-chaining call returns undefined for them and the
    // chat-input branch below still runs.
    if (typeof interaction.isButton === 'function' && interaction.isButton()) {
      try {
        const adaptedButton = adaptSubagentButtonInteraction(interaction);
        if (adaptedButton !== undefined) {
          await handlers.handleInteraction(adaptedButton);
        }
      } catch (error) {
        console.error(
          'discord-button-handler-error',
          JSON.stringify({
            customId: interaction.customId,
            ...summarizeInteractionHandlerError(error),
          }),
        );
      }
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!isDiscordFirstSliceCommandName(interaction.commandName)) {
      return;
    }

    const adaptedInteraction = adaptChatInputInteraction(interaction);
    try {
      await handlers.handleInteraction(adaptedInteraction);
    } catch (error) {
      console.error(
        'discord-interaction-handler-error',
        JSON.stringify({
          commandName: interaction.commandName,
          ...summarizeInteractionHandlerError(error),
        }),
      );
    }
  });

  if (options.enableNaturalLanguageMessages === true) {
    client.on(Events.MessageCreate, async (message) => {
      const botUserId = client.user?.id;
      if (!botUserId) {
        return;
      }
      const contextEntry = adaptDiscordMessageContextEntry(message);
      options.controlLedger?.append({
        type: 'conversation.message_observed',
        actor: {
          kind: 'discord-user',
          userId: contextEntry.authorId,
        },
        channel: {
          kind: 'discord',
          ...(contextEntry.guildId === undefined
            ? {}
            : { guildId: contextEntry.guildId }),
          ...(contextEntry.channelId === undefined
            ? {}
            : { channelId: contextEntry.channelId }),
          ...(contextEntry.messageId === undefined
            ? {}
            : { messageId: contextEntry.messageId }),
        },
        conversationId: contextEntry.channelId,
        trust: {
          source: 'discord',
          inputTrust: 'untrusted',
        },
        payload: {
          content: contextEntry.content,
          authorIsBot: contextEntry.authorIsBot,
        },
      });
      const triggerMode = options.naturalLanguageTriggerMode ?? 'mention';
      const isPotentialTaskMessage =
        contextEntry.authorIsBot !== true &&
        contextEntry.authorId !== botUserId &&
        extractNaturalLanguageAskInstruction(
          contextEntry.content,
          botUserId,
          {
            prefixes: options.naturalLanguagePrefixes,
            triggerMode,
            allowNonLeadingMentions: true,
          },
        ) !== undefined;

      if (
        messageContextHistory !== undefined &&
        options.enableMessageContextHistoryBackfill === true &&
        isPotentialTaskMessage
      ) {
        try {
          const backfillEntries = await fetchDiscordMessageContextBackfill(
            message,
            options.messageContextHistoryBackfillLimit ??
              options.messageContextHistoryLimit ??
              30,
          );
          messageContextHistory.appendMany(backfillEntries);
        } catch (error) {
          console.error(
            'discord-context-history-backfill-error',
            JSON.stringify({
              ...summarizeInteractionHandlerError(error),
            }),
          );
        }
      }

      messageContextHistory?.append(contextEntry);

      const adaptedMessage = adaptNaturalLanguageMessage(
        message,
        botUserId,
        {
          prefixes: options.naturalLanguagePrefixes,
          triggerMode,
          contextHistory: messageContextHistory?.snapshot(
            contextEntry.channelId,
            options.messageContextHistoryLimit,
          ),
          allowNonLeadingMentions: true,
        },
      );
      if (!adaptedMessage) {
        if (
          options.enableNaturalLanguagePrefixNotice === true &&
          triggerMode === 'mention' &&
          contextEntry.authorIsBot !== true &&
          contextEntry.authorId !== botUserId &&
          extractNaturalLanguagePrefixInstruction(
            contextEntry.content,
            botUserId,
            options.naturalLanguagePrefixes,
          ) !== undefined
        ) {
          await message.reply({
            content:
              '현재 이 채널에서는 작업 실행을 위해 봇 멘션으로 시작해야 합니다. 예: `<@bot> 작업 내용을 적어주세요.` Prefix-only 메시지는 context history로만 저장됩니다.',
          });
        }
        return;
      }

      try {
        await handlers.handleInteraction(adaptedMessage);
      } catch (error) {
        console.error(
          'discord-natural-language-handler-error',
          JSON.stringify({
            ...summarizeInteractionHandlerError(error),
          }),
        );
      }
    });
  }

  logDiscordBotLifecycle(lifecycleLogger, 'client-login-start');
  await client.login(options.token);
  logDiscordBotLifecycle(lifecycleLogger, 'client-login-resolved');

  if (options.waitForReadyOnStart === true) {
    logDiscordBotLifecycle(lifecycleLogger, 'client-ready-wait-start', {
      timeoutMs: options.readyTimeoutMs ?? DEFAULT_DISCORD_READY_TIMEOUT_MS,
    });
    await waitForDiscordClientReady(
      client,
      options.readyTimeoutMs ?? DEFAULT_DISCORD_READY_TIMEOUT_MS,
    );
    logDiscordBotLifecycle(lifecycleLogger, 'client-ready-wait-complete');
  }

  if (options.registerCommandsOnStart ?? true) {
    logDiscordBotLifecycle(lifecycleLogger, 'command-registration-start', {
      applicationId: options.applicationId,
      guildId: options.guildId,
    });
    await registerDiscordFirstSliceCommands({
      token: options.token,
      applicationId: options.applicationId,
      guildId: options.guildId,
    });
    logDiscordBotLifecycle(lifecycleLogger, 'command-registration-complete', {
      applicationId: options.applicationId,
      guildId: options.guildId,
    });
  }

  return {
    client,
    handlers,
    taskRegistry,
    async stop() {
      await client.destroy();
    },
  };
}
