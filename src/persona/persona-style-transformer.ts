/**
 * Persona style transformer port.
 *
 * The persona layer rewrites the *narrative prose* of a Discord-facing
 * payload through a small auxiliary model before chunking and delivery.
 * It is a presentation-only seam: the dispatcher / runtime / control-ledger
 * are not aware of it, and a transformer failure is fail-open — the original
 * payload is delivered verbatim. This preserves the existing UX-stable label
 * vocabulary (success / failure / runtime-veto / etc.) as a hard contract
 * while letting operators pick a softer voice for end-user messages.
 *
 * Conversation gate: only a narrow allowlist of low-risk conversational
 * `DiscordDeliveryEventType`s flows through transformation by default.
 * Structured listings (`tasks-reply`, `traits-reply`, `agenda-reply`,
 * `history-reply`, `context-reply`, `feed-reply`, `auth-reply`), operator-diagnostic surfaces
 * (`doctor-reply`, `help-reply`), and terminal/control surfaces
 * (`terminal-result`, archive/rerun replies,
 * approval/escalation/focus/subagent/follow-up replies) bypass the
 * transformer to keep the verbatim shape that automation consumers rely on.
 */

import type { DiscordDeliveryEventType } from '../discord/delivery/discord-delivery-types.js';

export type PersonaMode = 'duet' | 'off';

/**
 * Event types that carry conversational prose to the user. These are eligible
 * for persona-style transformation. Any other event type bypasses the
 * transformer and is delivered verbatim.
 */
export const CONVERSATIONAL_PERSONA_EVENT_TYPES: ReadonlySet<DiscordDeliveryEventType> =
  new Set<DiscordDeliveryEventType>([
    'ask-accepted',
    'running-update',
    'status-reply',
    'cancel-ack',
    'access-denied',
  ]);

/**
 * Event types whose payload shape is treated as an automation/control
 * contract. They remain verbatim even if an operator accidentally includes
 * them in AUTO_ARCHIVE_PERSONA_EVENT_TYPES or a custom transformer advertises
 * them in `eventTypes`. Expanding this list requires a reply-family
 * protected-token contract and consumer-compatibility tests first.
 */
export const HARD_VERBATIM_PERSONA_EVENT_TYPES: ReadonlySet<DiscordDeliveryEventType> =
  new Set<DiscordDeliveryEventType>([
    'ask-veto',
    'terminal-result',
    'rerun-reply',
    'archive-reply',
    'unarchive-reply',
    'tasks-reply',
    'traits-reply',
    'agenda-reply',
    'history-reply',
    'context-reply',
    'feed-reply',
    'escalate-reply',
    'doctor-reply',
    'subagents-reply',
    'focus-reply',
    'auth-reply',
    'config-reply',
    'help-reply',
    'approval-reply',
    'buffered-followup',
  ]);

export function isConversationalPersonaEventType(
  eventType: DiscordDeliveryEventType | undefined,
): boolean {
  return eventType !== undefined && CONVERSATIONAL_PERSONA_EVENT_TYPES.has(eventType);
}

export function isPersonaEventTypeTransformable(
  eventType: DiscordDeliveryEventType | undefined,
  allowedEventTypes: ReadonlySet<DiscordDeliveryEventType> =
    CONVERSATIONAL_PERSONA_EVENT_TYPES,
): boolean {
  return (
    eventType !== undefined &&
    allowedEventTypes.has(eventType) &&
    !HARD_VERBATIM_PERSONA_EVENT_TYPES.has(eventType)
  );
}

export interface PersonaTransformInput {
  /** Full pre-chunk payload text. The transformer rewrites this as a whole. */
  readonly text: string;
  /** Discord delivery event type — used by the transformer's gate / prompt. */
  readonly eventType: DiscordDeliveryEventType;
  /** Optional task correlation key, surfaced verbatim to the prompt. */
  readonly taskId?: string;
}

export interface PersonaStyleTransformer {
  /**
   * Optional per-transformer event gate. Env-created transformers populate
   * this when `AUTO_ARCHIVE_PERSONA_EVENT_TYPES` is configured; callers that
   * use simple test doubles may omit it and receive the safe default allowlist
   * above.
   */
  readonly eventTypes?: ReadonlySet<DiscordDeliveryEventType>;
  /**
   * Returns the transformed text. MUST NOT throw — implementations are
   * expected to swallow infrastructure errors and return `input.text` so
   * delivery always proceeds (fail-open).
   */
  transform(input: PersonaTransformInput): Promise<string>;
}

/**
 * Pass-through transformer used as the safe default and as a test double.
 */
export class NoopPersonaStyleTransformer implements PersonaStyleTransformer {
  // eslint-disable-next-line @typescript-eslint/require-await -- PersonaStyleTransformer.transform contract is Promise<string>; the noop pass-through has no async work.
  async transform(input: PersonaTransformInput): Promise<string> {
    return input.text;
  }
}

const PROTECTED_LIFECYCLE_WORDS = [
  'success',
  'failure',
  'accepted',
  'admission-denied',
  'runtime-entering',
  'runtime-running',
  'runtime-veto',
  'driver-failure',
  'provider-failure',
  'settling',
  'terminal',
  'timeout',
  'operator-cancel',
  'external-cancel',
  'abort',
  'running',
  'superseded',
  'advisory',
  'authoritative',
] as const;

/**
 * Extract exact spans that must survive a persona rewrite. The guard is
 * intentionally conservative: if a model drops task ids, URLs, code spans,
 * paths, timestamps, numeric codes, or lifecycle labels, delivery falls back
 * to the original text rather than risking lossy operator output.
 */
export function extractPersonaProtectedTokens(text: string): readonly string[] {
  const tokens: string[] = [];
  const add = (value: string | undefined): void => {
    const token = value?.trim();
    if (token !== undefined && token.length > 0 && !tokens.includes(token)) {
      tokens.push(token);
    }
  };
  const addMatches = (pattern: RegExp, mapper?: (match: RegExpExecArray) => string): void => {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      add(mapper?.(match) ?? match[0]);
      match = pattern.exec(text);
    }
  };

  addMatches(/```[\s\S]*?```/gu);
  addMatches(/`[^`\n]+`/gu);
  addMatches(/\bhttps?:\/\/[^\s<>)\]]+/giu);
  addMatches(/\bdiscord-task-[A-Za-z0-9_-]+\b/gu);
  addMatches(
    /["'](?:taskId|allocationId|bindingId|agendaId|approvalId)["']\s*:\s*["']([^"']+)["']/giu,
    (match) => match[1] ?? match[0],
  );
  addMatches(
    /[?&](?:taskId|allocationId|bindingId|agendaId|approvalId)=([^&#\s]+)/giu,
    (match) => decodeURIComponentSafe(match[1] ?? match[0]),
  );
  addMatches(
    /\b(?:taskId|allocationId|bindingId|agendaId|approvalId)\s*[:=]\s*([A-Za-z0-9._:-]+)/giu,
    (match) => match[1] ?? match[0],
  );
  addMatches(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
  );
  addMatches(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/gu);
  addMatches(/(?:^|[\s([{])((?:\.{1,2}\/|\/)[^\s`'")\]}]+)/gu, (match) => match[1] ?? match[0]);
  addMatches(/\b\d+(?:\.\d+)?\b/gu);

  for (const word of PROTECTED_LIFECYCLE_WORDS) {
    const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'giu');
    addMatches(pattern);
  }

  return tokens;
}

export function findMissingPersonaProtectedTokens(
  original: string,
  transformed: string,
): readonly string[] {
  return extractPersonaProtectedTokens(original).filter(
    (token) => !transformed.includes(token),
  );
}

const ARONA_BLOCK_PREFIX = '**아로나:**';
const PLANA_BLOCK_PREFIX = '**플라나:**';

/**
 * Validate the strict two-block duet shape requested from the persona model.
 * A malformed transform is treated like any other presentation-layer miss:
 * callers should fail open to the original payload.
 */
export function isValidAronaPlanaDuetOutput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith(ARONA_BLOCK_PREFIX)) {
    return false;
  }

  const planaSeparator = `\n\n${PLANA_BLOCK_PREFIX}`;
  const planaIndex = trimmed.indexOf(planaSeparator);
  if (planaIndex <= ARONA_BLOCK_PREFIX.length) {
    return false;
  }

  if (trimmed.indexOf(planaSeparator, planaIndex + planaSeparator.length) !== -1) {
    return false;
  }

  const aronaBody = trimmed.slice(ARONA_BLOCK_PREFIX.length, planaIndex).trim();
  const planaBody = trimmed.slice(planaIndex + planaSeparator.length).trim();
  if (aronaBody.length === 0 || planaBody.length === 0) {
    return false;
  }

  return !planaBody.includes('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
