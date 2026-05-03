#!/usr/bin/env node
/**
 * Local OpenAI-compatible stub used for end-to-end persona testing.
 *
 * Returns a deterministic Arona/Plana duet that echoes the original payload
 * fragment so a peekaboo evaluator can verify (a) the duet structure and
 * (b) verbatim preservation of the original taskId/marker substring.
 *
 * Usage:
 *   node scripts/dev/persona-stub-openai-server.mjs --port 8787
 *
 * Container reach (compose bridge gateway): http://172.22.0.1:8787/v1
 */

import { createServer } from 'node:http';

const port = Number.parseInt(
  process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ??
    process.env.PERSONA_STUB_PORT ??
    '8787',
  10,
);

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid json' } }));
      return;
    }

    const userMsg = (payload?.messages ?? []).find((m) => m.role === 'user');
    const userText =
      typeof userMsg?.content === 'string' ? userMsg.content : '';
    // Preserve a substring so the evaluator can verify verbatim contracts.
    const echoMatch = userText.match(/persona-2026-04-30_T\d+/u);
    const echo = echoMatch ? echoMatch[0] : 'no-marker';
    const eventMatch = userText.match(/\[eventType\]\s+(\S+)/u);
    const eventType = eventMatch ? eventMatch[1] : 'unknown-event';

    const duet = [
      `**아로나:** 선생님, 요청하신 작업이 ${eventType} 단계에 도착했어요. 마커 \`${echo}\` 도 그대로 유지되어 있답니다 ✨`,
      '',
      '**플라나:** 플라나는 추가 변형 없이 사실만 전달한다.',
    ].join('\n');

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `persona-stub-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: payload?.model ?? 'persona-stub',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: duet },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: userText.length,
          completion_tokens: duet.length,
          total_tokens: userText.length + duet.length,
        },
      }),
    );
  });
});

server.on('listening', () => {
  console.log(
    JSON.stringify({
      event: 'persona-stub-listening',
      port,
      url: `http://0.0.0.0:${port}`,
    }),
  );
});

server.listen(port, '0.0.0.0');

const stop = () => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
