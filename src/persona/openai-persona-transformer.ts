/**
 * OpenAI-compatible Chat Completions adapter for the persona style
 * transformer. Speaks the standard `/chat/completions` shape, so any
 * provider that mirrors that API (OpenAI, Azure OpenAI, OpenRouter,
 * vLLM, etc.) can be plugged in by overriding `baseUrl` + `model`.
 *
 * Failure mode: every transport / parsing failure returns the original
 * text. This is the only acceptable behaviour — persona is a presentation
 * layer and MUST NOT block delivery if the small model is unreachable
 * or quota-exhausted.
 */

import { ARONA_PLANA_DUET_SYSTEM_PROMPT } from './arona-plana-duet.js';
import type {
  PersonaStyleTransformer,
  PersonaTransformInput,
} from './persona-style-transformer.js';
import type { DiscordDeliveryEventType } from '../discord/delivery/discord-delivery-types.js';

export type PersonaLogger = (
  event: string,
  details: Readonly<Record<string, unknown>>,
) => void;

export interface OpenAIPersonaTransformerOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly latencyBudgetMs?: number;
  readonly sampleRate?: number;
  readonly random?: () => number;
  readonly fetch?: typeof fetch;
  readonly systemPrompt?: string;
  readonly logger?: PersonaLogger;
  readonly eventTypes?: ReadonlySet<DiscordDeliveryEventType>;
}

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TEMPERATURE = 0.5;

interface OpenAIChatChoice {
  readonly message?: { readonly content?: string };
}

interface OpenAIChatUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

interface OpenAIChatResponse {
  readonly choices?: readonly OpenAIChatChoice[];
  readonly usage?: OpenAIChatUsage;
}

export class OpenAIPersonaStyleTransformer implements PersonaStyleTransformer {
  readonly eventTypes?: ReadonlySet<DiscordDeliveryEventType>;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly latencyBudgetMs: number | undefined;
  private readonly sampleRate: number;
  private readonly random: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly systemPrompt: string;
  private readonly logger: PersonaLogger;

  constructor(options: OpenAIPersonaTransformerOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
      throw new Error('OpenAIPersonaStyleTransformer requires a non-empty apiKey.');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error(
        'OpenAIPersonaStyleTransformer requires a fetch implementation (globalThis.fetch is unavailable).',
      );
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.latencyBudgetMs = options.latencyBudgetMs;
    this.sampleRate = options.sampleRate ?? 1;
    this.random = options.random ?? Math.random;
    this.fetchImpl = fetchImpl;
    this.systemPrompt = options.systemPrompt ?? ARONA_PLANA_DUET_SYSTEM_PROMPT;
    this.logger = options.logger ?? (() => {});
    this.eventTypes = options.eventTypes;
  }

  async transform(input: PersonaTransformInput): Promise<string> {
    if (input.text.length === 0) {
      return input.text;
    }

    const startedAtMs = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const userContent = this.formatUserMessage(input);
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger('persona-transform-http-error', {
          status: response.status,
          eventType: input.eventType,
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        });
        this.logObservation(input, startedAtMs, 'fallback', 'http-error');
        return input.text;
      }

      let body: OpenAIChatResponse;
      try {
        body = (await response.json()) as OpenAIChatResponse;
      } catch (parseError) {
        this.logger('persona-transform-parse-error', {
          eventType: input.eventType,
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
        this.logObservation(input, startedAtMs, 'fallback', 'parse-error');
        return input.text;
      }

      const transformed = body.choices?.[0]?.message?.content?.trim();
      if (transformed === undefined || transformed.length === 0) {
        this.logger('persona-transform-empty', { eventType: input.eventType });
        this.logObservation(input, startedAtMs, 'fallback', 'empty', body.usage);
        return input.text;
      }
      this.logObservation(input, startedAtMs, 'success', undefined, body.usage, transformed);
      return transformed;
    } catch (error) {
      this.logger('persona-transform-error', {
        eventType: input.eventType,
        error: error instanceof Error ? error.message : String(error),
      });
      this.logObservation(input, startedAtMs, 'fallback', 'transport-error');
      return input.text;
    } finally {
      clearTimeout(timer);
    }
  }

  private logObservation(
    input: PersonaTransformInput,
    startedAtMs: number,
    outcome: 'success' | 'fallback',
    fallbackReason?: string,
    usage?: OpenAIChatUsage,
    transformed?: string,
  ): void {
    if (outcome === 'success' && this.sampleRate < 1 && this.random() >= this.sampleRate) {
      return;
    }
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    this.logger('persona-transform-observed', {
      eventType: input.eventType,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      model: this.model,
      outcome,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
      durationMs,
      ...(this.latencyBudgetMs === undefined
        ? {}
        : {
            latencyBudgetMs: this.latencyBudgetMs,
            withinLatencyBudget: durationMs <= this.latencyBudgetMs,
          }),
      inputChars: input.text.length,
      outputChars: transformed === undefined ? input.text.length : transformed.length,
      ...(usage?.prompt_tokens === undefined ? {} : { promptTokens: usage.prompt_tokens }),
      ...(usage?.completion_tokens === undefined
        ? {}
        : { completionTokens: usage.completion_tokens }),
      ...(usage?.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
    });
  }

  private formatUserMessage(input: PersonaTransformInput): string {
    const header = [
      `[eventType] ${input.eventType}`,
      input.taskId === undefined ? undefined : `[taskId] ${input.taskId}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
    return `${header}\n[원문]\n${input.text}`;
  }
}
