/**
 * Env-driven persona configuration.
 *
 * Returns `undefined` unless persona is explicitly enabled with
 * `AUTO_ARCHIVE_PERSONA_MODE=duet` and a persona-scoped API key. This keeps
 * the presentation-only model off by default and avoids accidentally reusing
 * broad runtime credentials.
 */

import {
  OpenAIPersonaStyleTransformer,
  type PersonaLogger,
} from './openai-persona-transformer.js';
import {
  CONVERSATIONAL_PERSONA_EVENT_TYPES,
  HARD_VERBATIM_PERSONA_EVENT_TYPES,
  type PersonaStyleTransformer,
} from './persona-style-transformer.js';
import type { DiscordDeliveryEventType } from '../discord/delivery/discord-delivery-types.js';

export const AUTO_ARCHIVE_PERSONA_MODE = 'AUTO_ARCHIVE_PERSONA_MODE';
export const AUTO_ARCHIVE_PERSONA_MODEL = 'AUTO_ARCHIVE_PERSONA_MODEL';
export const AUTO_ARCHIVE_PERSONA_API_KEY = 'AUTO_ARCHIVE_PERSONA_API_KEY';
export const AUTO_ARCHIVE_PERSONA_BASE_URL = 'AUTO_ARCHIVE_PERSONA_BASE_URL';
export const AUTO_ARCHIVE_PERSONA_TIMEOUT_MS = 'AUTO_ARCHIVE_PERSONA_TIMEOUT_MS';
export const AUTO_ARCHIVE_PERSONA_TEMPERATURE = 'AUTO_ARCHIVE_PERSONA_TEMPERATURE';
export const AUTO_ARCHIVE_PERSONA_ALLOW_OPENAI_API_KEY_FALLBACK =
  'AUTO_ARCHIVE_PERSONA_ALLOW_OPENAI_API_KEY_FALLBACK';
export const AUTO_ARCHIVE_PERSONA_EVENT_TYPES = 'AUTO_ARCHIVE_PERSONA_EVENT_TYPES';
export const AUTO_ARCHIVE_PERSONA_LATENCY_BUDGET_MS =
  'AUTO_ARCHIVE_PERSONA_LATENCY_BUDGET_MS';
export const AUTO_ARCHIVE_PERSONA_SAMPLING_LOG_RATE =
  'AUTO_ARCHIVE_PERSONA_SAMPLING_LOG_RATE';

const ALL_DISCORD_DELIVERY_EVENT_TYPES: ReadonlySet<DiscordDeliveryEventType> =
  new Set<DiscordDeliveryEventType>([
    'ask-veto',
    'ask-accepted',
    'running-update',
    'terminal-result',
    'status-reply',
    'cancel-ack',
    'tasks-reply',
    'agenda-reply',
    'history-reply',
    'context-reply',
    'doctor-reply',
    'subagents-reply',
    'focus-reply',
    'auth-reply',
    'help-reply',
    'access-denied',
    'approval-reply',
    'buffered-followup',
  ]);

export interface CreatePersonaTransformerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: PersonaLogger;
}

export function createPersonaTransformerFromEnv(
  options: CreatePersonaTransformerOptions = {},
): PersonaStyleTransformer | undefined {
  const env = options.env ?? process.env;
  const mode = (env[AUTO_ARCHIVE_PERSONA_MODE] ?? 'off').trim().toLowerCase();
  if (mode !== 'duet') {
    return undefined;
  }

  const personaApiKey = (env[AUTO_ARCHIVE_PERSONA_API_KEY] ?? '').trim();
  const allowOpenAiFallback =
    (env[AUTO_ARCHIVE_PERSONA_ALLOW_OPENAI_API_KEY_FALLBACK] ?? '').trim() === '1';
  const apiKey =
    personaApiKey.length > 0
      ? personaApiKey
      : allowOpenAiFallback
        ? (env['OPENAI_API_KEY'] ?? '').trim()
        : '';
  if (apiKey.length === 0) {
    return undefined;
  }

  const model = (env[AUTO_ARCHIVE_PERSONA_MODEL] ?? '').trim();
  const baseUrl = (env[AUTO_ARCHIVE_PERSONA_BASE_URL] ?? '').trim();
  const timeoutRaw = (env[AUTO_ARCHIVE_PERSONA_TIMEOUT_MS] ?? '').trim();
  const temperatureRaw = (env[AUTO_ARCHIVE_PERSONA_TEMPERATURE] ?? '').trim();
  const latencyBudgetRaw = (env[AUTO_ARCHIVE_PERSONA_LATENCY_BUDGET_MS] ?? '').trim();
  const sampleRateRaw = (env[AUTO_ARCHIVE_PERSONA_SAMPLING_LOG_RATE] ?? '').trim();

  let timeoutMs: number | undefined;
  if (timeoutRaw.length > 0) {
    const parsed = Number.parseInt(timeoutRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      timeoutMs = parsed;
    }
  }

  let temperature: number | undefined;
  if (temperatureRaw.length > 0) {
    const parsed = Number.parseFloat(temperatureRaw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      temperature = parsed;
    }
  }

  let latencyBudgetMs: number | undefined;
  if (latencyBudgetRaw.length > 0) {
    const parsed = Number.parseInt(latencyBudgetRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      latencyBudgetMs = parsed;
    }
  }

  let sampleRate: number | undefined;
  if (sampleRateRaw.length > 0) {
    const parsed = Number.parseFloat(sampleRateRaw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      sampleRate = parsed;
    }
  }

  return new OpenAIPersonaStyleTransformer({
    apiKey,
    eventTypes: parsePersonaEventTypes(env[AUTO_ARCHIVE_PERSONA_EVENT_TYPES], options.logger),
    ...(model.length > 0 ? { model } : {}),
    ...(baseUrl.length > 0 ? { baseUrl } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(latencyBudgetMs === undefined ? {} : { latencyBudgetMs }),
    ...(sampleRate === undefined ? {} : { sampleRate }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

export function parsePersonaEventTypes(
  rawValue: string | undefined,
  logger?: PersonaLogger,
): ReadonlySet<DiscordDeliveryEventType> {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return new Set(CONVERSATIONAL_PERSONA_EVENT_TYPES);
  }

  const parsed = new Set<DiscordDeliveryEventType>();
  const invalid: string[] = [];
  for (const raw of rawValue.split(',')) {
    const eventType = raw.trim();
    if (eventType.length === 0) {
      continue;
    }
    if (ALL_DISCORD_DELIVERY_EVENT_TYPES.has(eventType as DiscordDeliveryEventType)) {
      const typedEventType = eventType as DiscordDeliveryEventType;
      if (HARD_VERBATIM_PERSONA_EVENT_TYPES.has(typedEventType)) {
        invalid.push(`${eventType}:protected-verbatim`);
        continue;
      }
      parsed.add(typedEventType);
    } else {
      invalid.push(eventType);
    }
  }

  if (invalid.length > 0) {
    logger?.('persona-event-types-invalid', {
      invalidCount: invalid.length,
      invalidEventTypes: invalid,
    });
  }

  if (parsed.size === 0) {
    logger?.('persona-event-types-empty', {
      fallback: 'default-conversational-allowlist',
    });
    return new Set(CONVERSATIONAL_PERSONA_EVENT_TYPES);
  }

  return parsed;
}
