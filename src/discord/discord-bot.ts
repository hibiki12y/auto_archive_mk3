import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type ClientOptions,
  type Message,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

import type { Arona } from '../core/arona.js';
import type { Dispatcher } from '../core/dispatcher.js';
import type { RuntimeApprovalRegistry } from '../core/runtime-approval-registry.js';
import type { ControlPlaneLedgerPort } from '../control/control-plane-ledger.js';
import {
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  type DefaultDiscordTaskRequestFactoryOptions,
  type DiscordCommandInteractionAdapter,
} from './discord-command-handlers.js';
import {
  buildDiscordFirstSliceCommands,
  isDiscordFirstSliceCommandName,
  type DiscordFirstSliceCommandName,
} from './discord-command-registry.js';
import type { DiscordDoctorStatus } from './discord-result-renderer.js';
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
    return Array.from(value.values() as Iterable<unknown>);
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
  readonly state?: 'accepted' | 'running' | 'terminal' | 'active' | 'all';
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

function extractNaturalLanguageLimit(content: string): string | undefined {
  const english = content.match(
    /\b(?:last|latest|recent|limit|show)\s+(?<limit>\d{1,2})\b/iu,
  )?.groups?.limit;
  if (english !== undefined) {
    return english;
  }
  return content.match(/(?:최근|마지막|최신)\s*(?<limit>\d{1,2})\s*(?:개|건)?/u)
    ?.groups?.limit;
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
): 'accepted' | 'running' | 'terminal' | 'active' | 'all' {
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
    return {
      commandName: 'history',
      ...(taskId === undefined ? {} : { taskId }),
      ...(limit === undefined ? {} : { limit }),
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
    /\b(?:doctor|health|readiness|diagnostic|diagnostics)\b/u.test(normalized) ||
    /(?:진단|헬스|상태\s*점검|서비스\s*상태|준비\s*상태)/u.test(instruction)
  ) {
    return { commandName: 'doctor' };
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
    /\b(?:research|investigate|analy[sz]e|survey|literature|benchmark|evaluate|verify|experiment)\b/u.test(
      normalized,
    ) ||
    /(?:리서치|조사|연구|분석|문헌|벤치마크|평가|검증|실험)/u.test(instruction)
  ) {
    return { commandName: 'research' };
  }

  return undefined;
}

export function extractSlashTextControlInstruction(
  content: string,
): string | undefined {
  const match = content.match(
    /^\s*\/(?<command>status|cancel|tasks|agenda|history|context|approve|deny|doctor|subagents|focus|unfocus|auth|help)(?:\s+(?<rest>[\s\S]*?)\s*)?$/iu,
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
    editReply: (payload) => Promise.resolve(validated.editReply(payload)),
    followUp: (payload) => Promise.resolve(validated.followUp(payload)),
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
    editReply: (payload) => Promise.resolve(validated.reply(payload)),
    followUp: (payload) => Promise.resolve(validated.reply(payload)),
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
  sessionBindings?: import('./discord-session-binding.js').DiscordSessionBindingManager;
  personaTransformer?: import('../persona/persona-style-transformer.js').PersonaStyleTransformer;
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
    sessionBindings: options.sessionBindings,
    doctorStatus: options.doctorStatus,
    ...(options.personaTransformer === undefined
      ? {}
      : { personaTransformer: options.personaTransformer }),
  });
  const messageContextHistory =
    options.enableMessageContextHistory === true
      ? new DiscordMessageContextHistory(options.messageContextHistoryMaxEntries)
      : undefined;

  client.on(Events.InteractionCreate, async (interaction) => {
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
      client.destroy();
    },
  };
}
