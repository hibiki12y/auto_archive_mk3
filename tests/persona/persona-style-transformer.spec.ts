import { describe, expect, it, vi } from 'vitest';

import {
  CONVERSATIONAL_PERSONA_EVENT_TYPES,
  HARD_VERBATIM_PERSONA_EVENT_TYPES,
  isConversationalPersonaEventType,
  isPersonaEventTypeTransformable,
  NoopPersonaStyleTransformer,
  OpenAIPersonaStyleTransformer,
  createPersonaTransformerFromEnv,
  extractPersonaProtectedTokens,
  findMissingPersonaProtectedTokens,
  isValidAronaPlanaDuetOutput,
  parsePersonaMothballedFlag,
  parsePersonaEventTypes,
  ARONA_PLANA_DUET_SYSTEM_PROMPT,
} from '../../src/persona/index.js';
import type { DiscordDeliveryEventType } from '../../src/discord/delivery/discord-delivery-types.js';

describe('persona — conversational gate', () => {
  it('classifies conversational event types as conversational', () => {
    const conversational: readonly DiscordDeliveryEventType[] = [
      'ask-accepted',
      'running-update',
      'status-reply',
      'cancel-ack',
      'access-denied',
    ];
    for (const eventType of conversational) {
      expect(isConversationalPersonaEventType(eventType)).toBe(true);
      expect(CONVERSATIONAL_PERSONA_EVENT_TYPES.has(eventType)).toBe(true);
    }
  });

  it('classifies structured listings, diagnostics, and terminal/control replies as verbatim', () => {
    const verbatim: readonly DiscordDeliveryEventType[] = [
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
      'escalate-reply',
      'feed-reply',
      'doctor-reply',
      'auth-reply',
      'help-reply',
      'approval-reply',
      'focus-reply',
      'subagents-reply',
      'insights-reply',
      'research-mission-reply',
      'buffered-followup',
    ];
    for (const eventType of verbatim) {
      expect(isConversationalPersonaEventType(eventType)).toBe(false);
      expect(isPersonaEventTypeTransformable(eventType)).toBe(false);
      expect(CONVERSATIONAL_PERSONA_EVENT_TYPES.has(eventType)).toBe(false);
      expect(HARD_VERBATIM_PERSONA_EVENT_TYPES.has(eventType)).toBe(true);
    }
  });

  it('classifies insights-reply as hard-verbatim (Risk 9 §09 audit)', () => {
    // Pinning test for Risk 9 §09: `insights-reply` was previously in
    // neither the conversational nor the hard-verbatim set, so it went
    // verbatim by accident (default = not-conversational). It is now
    // classified explicitly as HARD_VERBATIM because the payload from
    // `renderInsights` is a structured tabular listing (numeric rows,
    // breakdowns, top-failure rows) — same family as `tasks-reply` and
    // `feed-reply` — not conversational prose.
    expect(CONVERSATIONAL_PERSONA_EVENT_TYPES.has('insights-reply')).toBe(false);
    expect(HARD_VERBATIM_PERSONA_EVENT_TYPES.has('insights-reply')).toBe(true);
    expect(isConversationalPersonaEventType('insights-reply')).toBe(false);
    expect(isPersonaEventTypeTransformable('insights-reply')).toBe(false);
  });

  it('refuses an operator override that tries to opt insights-reply into the persona allowlist', () => {
    // The protected-verbatim filter must fire with an explicit reason so
    // operators get a clear log line rather than silent ignoring of a
    // configured event type.
    const logger = vi.fn();
    const eventTypes = parsePersonaEventTypes('insights-reply,status-reply', logger);
    expect(eventTypes.has('insights-reply')).toBe(false);
    expect(eventTypes.has('status-reply')).toBe(true);
    expect(logger).toHaveBeenCalledWith(
      'persona-event-types-invalid',
      expect.objectContaining({
        invalidEventTypes: ['insights-reply:protected-verbatim'],
      }),
    );
  });

  it('rejects undefined eventType', () => {
    expect(isConversationalPersonaEventType(undefined)).toBe(false);
  });
});

describe('persona — protected output invariant', () => {
  it('extracts exact task ids, code spans, urls, paths, timestamps, and numbers', () => {
    const tokens = extractPersonaProtectedTokens(
      'Task discord-task-abc_123 wrote `result.json` at /tmp/run-1 on 2026-04-30T12:00:00.000Z; see https://example.test/a and exit code 42.',
    );

    expect(tokens).toContain('discord-task-abc_123');
    expect(tokens).toContain('`result.json`');
    expect(tokens).toContain('/tmp/run-1');
    expect(tokens).toContain('2026-04-30T12:00:00.000Z');
    expect(tokens).toContain('https://example.test/a');
    expect(tokens).toContain('42');
  });

  it('reports missing protected spans when a rewrite drops identifiers', () => {
    const missing = findMissingPersonaProtectedTokens(
      'Task discord-task-abc finished with success at /tmp/out and exit code 0.',
      '완료되었습니다.',
    );

    expect(missing).toContain('discord-task-abc');
    expect(missing).toContain('/tmp/out');
    expect(missing).toContain('success');
    expect(missing).toContain('0');
  });

  it('protects named correlation ids and the full lifecycle vocabulary used by the prompt', () => {
    const tokens = extractPersonaProtectedTokens(
      'allocationId=alloc-7 bindingId:bind-8 {"taskId":"task-json-1"} ?approvalId=approval-url-10 agendaId=agenda-9 moved through admission-denied, runtime-entering, runtime-running, settling, terminal, operator-cancel, abort, superseded, advisory, authoritative.',
    );

    expect(tokens).toContain('alloc-7');
    expect(tokens).toContain('bind-8');
    expect(tokens).toContain('task-json-1');
    expect(tokens).toContain('agenda-9');
    expect(tokens).toContain('approval-url-10');
    expect(tokens).toContain('admission-denied');
    expect(tokens).toContain('runtime-entering');
    expect(tokens).toContain('runtime-running');
    expect(tokens).toContain('settling');
    expect(tokens).toContain('terminal');
    expect(tokens).toContain('operator-cancel');
    expect(tokens).toContain('abort');
    expect(tokens).toContain('superseded');
    expect(tokens).toContain('advisory');
    expect(tokens).toContain('authoritative');
  });
});

describe('persona — Arona / Plana profile prompt', () => {
  it('encodes the dialogue-list-derived style profile without embedding source lines', () => {
    expect(ARONA_PLANA_DUET_SYSTEM_PROMPT).toContain(
      '[대사 목록 기반 스타일 프로필 — 직접 인용 금지]',
    );
    expect(ARONA_PLANA_DUET_SYSTEM_PROMPT).toContain(
      '실제 게임 대사를 복사하거나 번역문처럼 재현하지 말고',
    );
    expect(ARONA_PLANA_DUET_SYSTEM_PROMPT).toContain(
      '접속·인증·프로세스·대기·제한 가동',
    );
    expect(ARONA_PLANA_DUET_SYSTEM_PROMPT).toContain('[운영 메시지 어댑터]');
    expect(ARONA_PLANA_DUET_SYSTEM_PROMPT).toContain(
      'access-denied: 아로나는 권한 부족을 부드럽게 설명하되 우회 방법을 제안하지 않음',
    );
  });

  it('validates the strict Arona/Plana two-block output shape', () => {
    expect(
      isValidAronaPlanaDuetOutput(
        '**아로나:** 선생님, `task-1` 상태를 확인했어요.\n\n**플라나:** terminal 아님.',
      ),
    ).toBe(true);
    expect(isValidAronaPlanaDuetOutput('**아로나:** 단독 블록이에요.')).toBe(false);
    expect(
      isValidAronaPlanaDuetOutput(
        '**아로나:** 본문\n\n**플라나:** 첫 줄\n둘째 줄',
      ),
    ).toBe(false);
    expect(
      isValidAronaPlanaDuetOutput(
        '**플라나:** 순서 오류.\n\n**아로나:** 본문',
      ),
    ).toBe(false);
  });
});

describe('persona — NoopPersonaStyleTransformer', () => {
  it('returns input text verbatim', async () => {
    const transformer = new NoopPersonaStyleTransformer();
    const out = await transformer.transform({
      text: 'hello world',
      eventType: 'ask-accepted',
    });
    expect(out).toBe('hello world');
  });
});

describe('persona — OpenAIPersonaStyleTransformer', () => {
  function makeFetchOk(content: string): typeof fetch {
    return vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  it('returns transformed content on a 200 response', async () => {
    const fetchImpl = makeFetchOk('**아로나:** 메시지\n\n**플라나:** 끝.');
    const transformer = new OpenAIPersonaStyleTransformer({
      apiKey: 'sk-test',
      fetch: fetchImpl,
    });
    const out = await transformer.transform({
      text: 'Task `task-foo` is running.',
      eventType: 'running-update',
      taskId: 'task-foo',
    });
    expect(out).toBe('**아로나:** 메시지\n\n**플라나:** 끝.');
  });

  it('logs sampled latency/cost observations without logging message bodies', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '**아로나:** ok\n\n**플라나:** done.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const logger = vi.fn();
    const transformer = new OpenAIPersonaStyleTransformer({
      apiKey: 'sk-test',
      fetch: fetchImpl,
      logger,
      model: 'small-model-1',
      latencyBudgetMs: 10_000,
      sampleRate: 1,
    });

    await transformer.transform({
      text: 'Task `task-foo` is running.',
      eventType: 'running-update',
      taskId: 'task-foo',
    });

    expect(logger).toHaveBeenCalledWith(
      'persona-transform-observed',
      expect.objectContaining({
        eventType: 'running-update',
        taskId: 'task-foo',
        model: 'small-model-1',
        outcome: 'success',
        latencyBudgetMs: 10_000,
        withinLatencyBudget: true,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      }),
    );
    const observed = logger.mock.calls.find(
      ([event]) => event === 'persona-transform-observed',
    )?.[1] as Record<string, unknown>;
    expect(JSON.stringify(observed)).not.toContain('Task `task-foo` is running.');
  });

  it('passes apiKey, model, and base url to fetch', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const transformer = new OpenAIPersonaStyleTransformer({
      apiKey: 'sk-abc',
      model: 'small-model-1',
      baseUrl: 'https://example.test/v1/',
      fetch: fetchImpl,
    });
    await transformer.transform({ text: 'x', eventType: 'ask-accepted' });
    const callArgs = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toBe('https://example.test/v1/chat/completions');
    const init = callArgs[1] as RequestInit;
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-abc');
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('small-model-1');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe(ARONA_PLANA_DUET_SYSTEM_PROMPT);
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('[eventType] ask-accepted');
  });

  it('falls back to original text on HTTP error (fail-open)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('rate limited', { status: 429 }),
    ) as unknown as typeof fetch;
    const logger = vi.fn();
    const transformer = new OpenAIPersonaStyleTransformer({
      apiKey: 'sk-test',
      fetch: fetchImpl,
      logger,
    });
    const out = await transformer.transform({
      text: 'original',
      eventType: 'terminal-result',
    });
    expect(out).toBe('original');
    expect(logger).toHaveBeenCalledWith(
      'persona-transform-http-error',
      expect.objectContaining({ status: 429 }),
    );
  });

  it('falls back to original text when fetch throws (fail-open)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const logger = vi.fn();
    const transformer = new OpenAIPersonaStyleTransformer({
      apiKey: 'sk-test',
      fetch: fetchImpl,
      logger,
    });
    const out = await transformer.transform({
      text: 'original',
      eventType: 'cancel-ack',
    });
    expect(out).toBe('original');
    expect(logger).toHaveBeenCalledWith(
      'persona-transform-error',
      expect.objectContaining({ error: 'network down' }),
    );
  });

  it('falls back to original text on empty content', async () => {
    const fetchImpl = makeFetchOk('   ');
    const logger = vi.fn();
    const transformer = new OpenAIPersonaStyleTransformer({
      apiKey: 'sk-test',
      fetch: fetchImpl,
      logger,
    });
    const out = await transformer.transform({
      text: 'original',
      eventType: 'ask-accepted',
    });
    expect(out).toBe('original');
    expect(logger).toHaveBeenCalledWith(
      'persona-transform-empty',
      expect.anything(),
    );
  });

  it('passes empty string through without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const transformer = new OpenAIPersonaStyleTransformer({
      apiKey: 'sk-test',
      fetch: fetchImpl,
    });
    const out = await transformer.transform({ text: '', eventType: 'ask-accepted' });
    expect(out).toBe('');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects construction without apiKey', () => {
    expect(
      () =>
        new OpenAIPersonaStyleTransformer({
          apiKey: '',
          fetch: globalThis.fetch,
        }),
    ).toThrowError(/apiKey/);
  });
});

describe('persona — createPersonaTransformerFromEnv', () => {
  it('parses the mothball flag as archived unless explicitly disabled', () => {
    expect(parsePersonaMothballedFlag(undefined)).toBe(true);
    expect(parsePersonaMothballedFlag('')).toBe(true);
    expect(parsePersonaMothballedFlag('1')).toBe(true);
    expect(parsePersonaMothballedFlag('true')).toBe(true);
    expect(parsePersonaMothballedFlag('yes')).toBe(true);
    expect(parsePersonaMothballedFlag('0')).toBe(false);
    expect(parsePersonaMothballedFlag('false')).toBe(false);
    expect(parsePersonaMothballedFlag(' FALSE ')).toBe(false);
  });

  it('returns undefined when mode is off', () => {
    const result = createPersonaTransformerFromEnv({
      env: { AUTO_ARCHIVE_PERSONA_MODE: 'off', OPENAI_API_KEY: 'sk-x' },
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when no api key is provided', () => {
    const result = createPersonaTransformerFromEnv({ env: {} });
    expect(result).toBeUndefined();
  });

  it('stays disabled by default even when OPENAI_API_KEY is present', () => {
    const result = createPersonaTransformerFromEnv({
      env: { OPENAI_API_KEY: 'sk-x' },
    });
    expect(result).toBeUndefined();
  });

  it('stays archived by default even when mode is duet and a persona key is set', () => {
    const logger = vi.fn();
    const result = createPersonaTransformerFromEnv({
      env: {
        AUTO_ARCHIVE_PERSONA_MODE: 'duet',
        AUTO_ARCHIVE_PERSONA_API_KEY: 'sk-persona',
      },
      logger,
    });

    expect(result).toBeUndefined();
    expect(logger).toHaveBeenCalledWith(
      'persona-mothballed',
      expect.objectContaining({
        reactivation: 'AUTO_ARCHIVE_PERSONA_MOTHBALLED=0',
      }),
    );
  });

  it('returns a transformer only when persona is unmothballed, mode is duet, and AUTO_ARCHIVE_PERSONA_API_KEY is set', () => {
    const result = createPersonaTransformerFromEnv({
      env: {
        AUTO_ARCHIVE_PERSONA_MOTHBALLED: '0',
        AUTO_ARCHIVE_PERSONA_MODE: 'duet',
        AUTO_ARCHIVE_PERSONA_API_KEY: 'sk-persona',
        AUTO_ARCHIVE_PERSONA_LATENCY_BUDGET_MS: '500',
        AUTO_ARCHIVE_PERSONA_SAMPLING_LOG_RATE: '0.5',
      },
    });
    expect(result).toBeInstanceOf(OpenAIPersonaStyleTransformer);
  });

  it('allows OPENAI_API_KEY fallback only under the explicit fallback flag', () => {
    const disabled = createPersonaTransformerFromEnv({
      env: {
        AUTO_ARCHIVE_PERSONA_MODE: 'duet',
        OPENAI_API_KEY: 'sk-other',
      },
    });
    const enabled = createPersonaTransformerFromEnv({
      env: {
        AUTO_ARCHIVE_PERSONA_MOTHBALLED: '0',
        AUTO_ARCHIVE_PERSONA_MODE: 'duet',
        AUTO_ARCHIVE_PERSONA_ALLOW_OPENAI_API_KEY_FALLBACK: '1',
        OPENAI_API_KEY: 'sk-other',
      },
    });

    expect(disabled).toBeUndefined();
    expect(enabled).toBeInstanceOf(OpenAIPersonaStyleTransformer);
  });

  it('prefers AUTO_ARCHIVE_PERSONA_API_KEY over OPENAI_API_KEY when fallback is allowed', () => {
    const result = createPersonaTransformerFromEnv({
      env: {
        AUTO_ARCHIVE_PERSONA_MOTHBALLED: '0',
        AUTO_ARCHIVE_PERSONA_MODE: 'duet',
        AUTO_ARCHIVE_PERSONA_API_KEY: 'sk-persona',
        AUTO_ARCHIVE_PERSONA_ALLOW_OPENAI_API_KEY_FALLBACK: '1',
        OPENAI_API_KEY: 'sk-other',
      },
    });
    expect(result).toBeInstanceOf(OpenAIPersonaStyleTransformer);
  });

  it('parses optional persona event type overrides but refuses protected verbatim surfaces', () => {
    const logger = vi.fn();
    const eventTypes = parsePersonaEventTypes(
      'terminal-result, rerun-reply, status-reply, nope',
      logger,
    );

    expect(eventTypes.has('terminal-result')).toBe(false);
    expect(eventTypes.has('rerun-reply')).toBe(false);
    expect(eventTypes.has('status-reply')).toBe(true);
    expect(eventTypes.has('ask-accepted')).toBe(false);
    expect(logger).toHaveBeenCalledWith(
      'persona-event-types-invalid',
      expect.objectContaining({
        invalidEventTypes: [
          'terminal-result:protected-verbatim',
          'rerun-reply:protected-verbatim',
          'nope',
        ],
      }),
    );
  });
});
