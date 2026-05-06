#!/usr/bin/env node
// Bot baseline probe — sends a trivial "stub returns 1+1" task to the Discord
// bot via slash-ask and reports whether the bot can complete a minimum-scope
// turn. Intended as the resume-protocol gate for the eval-improve-loop after
// the 2026-05-06 evening ceiling regression (memory:
// `bot-ceiling-regression-2026-05-06-evening`).
//
// Exit codes:
//   0  — bot responded with a task-complete terminal-result containing the
//        expected artifact path.
//   2  — bot accepted the task but terminated with abort/timeout/no-artifact.
//   3  — submit itself failed (transport / proxy / readiness).
//
// Output: structured JSON on stdout summarizing the probe outcome.
//
// Usage:
//   node scripts/probe-bot-baseline.mjs [--marker <id>] [--channel-id <id>]
//                                       [--timeout-ms <ms>] [--keep-artifact]
//
// All flags are optional. Defaults are channel/guild from env or
// agent-node-discord-direct-control's own defaults.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 360_000;
const HELPER_PATH = resolve(
  new URL('./agent-node-discord-direct-control.mjs', import.meta.url).pathname,
);

const TRIVIAL_PROMPT = `Implementation research task — bot baseline probe.

[bot-baseline-probe]

Single trivial standalone module to verify the bot runtime can deliver a minimum-scope turn.

FILE 1: \`runtime-state/probe/stub.ts\` (≤30 lines, JS-with-JSDoc, .ts ext, data:URL loadable, NO sibling .ts imports).

Export ONE function: \`compute() => 2\`.

FILE 2: \`runtime-state/probe/stub.test.mjs\` — exactly 3 assertions in a single subtest. Load stub.ts via \`data:text/javascript;charset=utf-8,\${encodeURIComponent(source)}\`. Assert: (a) compute() returns 2, (b) compute() === compute(), (c) typeof compute === "function".

End: \`process.on("beforeExit", () => console.log(\\\`PROBE_TESTS_OK n=\${assertions}\\\`));\`

Constraints: ≤3 tests; ≤1 fix iter; write ONLY these 2 files. Verify only \`node --test stub.test.mjs\` exits 0.
`;

function parseArgs(argv) {
  const args = {
    marker: `bot-baseline-probe-${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}`,
    channelId: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keepArtifact: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--marker') args.marker = argv[++i];
    else if (arg === '--channel-id') args.channelId = argv[++i];
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--keep-artifact') args.keepArtifact = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/probe-bot-baseline.mjs [--marker <id>] [--channel-id <id>] [--timeout-ms <ms>] [--keep-artifact]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`probe-bot-baseline: unknown argument ${arg}\n`);
      process.exit(64);
    }
  }
  return args;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function submitProbe(args) {
  const helperArgs = [
    HELPER_PATH,
    '--mode',
    'slash-ask',
    '--message',
    TRIVIAL_PROMPT,
    '--marker',
    args.marker,
    '--observe-mode',
    'see',
  ];
  if (args.channelId) {
    helperArgs.push('--channel-id', args.channelId);
  }
  const result = spawnSync('node', helperArgs, {
    encoding: 'utf8',
    timeout: args.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    return { ok: false, errorMessage: result.error.message, exitStatus: result.status };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      errorMessage: 'helper exit non-zero',
      exitStatus: result.status,
      stderrTail: (result.stderr || '').slice(-1500),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    return { ok: false, errorMessage: `JSON parse failed: ${err.message}`, stdoutTail: result.stdout.slice(-500) };
  }
  return { ok: true, parsed };
}

function deriveOutcome(parsed) {
  const evidence = parsed?.evidence ?? {};
  const observation = parsed?.observation ?? {};
  const matchedReply = observation?.matchedReply ?? {};
  const taskId = evidence?.taskCorrelation?.taskId ?? null;
  const liveOk = parsed?.readiness?.liveOk === true;
  const matchedReplyObserved = parsed?.readiness?.matchedReplyObserved === true;
  const replyContent = typeof matchedReply.content === 'string' ? matchedReply.content : '';
  const isAbort = /finished with `abort`/.test(replyContent);
  const isComplete = /finished with `complete`|terminal-result.*complete/i.test(replyContent);
  return {
    liveOk,
    matchedReplyObserved,
    matchedReplyContent: replyContent.slice(0, 600),
    taskId,
    bot: {
      reachedTerminal: matchedReplyObserved,
      terminalIsAbort: isAbort,
      terminalIsComplete: isComplete,
    },
  };
}

function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const submission = submitProbe(args);
  if (!submission.ok) {
    emit({
      ok: false,
      stage: 'submit',
      startedAt,
      finishedAt: new Date().toISOString(),
      summary: 'Bot probe submit itself failed (transport, proxy, or readiness).',
      error: submission,
    });
    process.exit(3);
  }
  const outcome = deriveOutcome(submission.parsed);
  const summary = !outcome.liveOk
    ? 'Live submission did not complete; verify proxy/bridge readiness.'
    : outcome.bot.terminalIsAbort
      ? 'Bot accepted but aborted — ceiling-regression signature; do NOT resume autonomous loop.'
      : outcome.bot.terminalIsComplete
        ? 'Bot completed minimum-scope task — safe to resume autonomous loop.'
        : 'Bot reached terminal but outcome was neither complete nor abort; investigate manually.';
  const exitCode = !outcome.liveOk
    ? 3
    : outcome.bot.terminalIsAbort || !outcome.bot.terminalIsComplete
      ? 2
      : 0;
  emit({
    ok: exitCode === 0,
    stage: 'observe',
    startedAt,
    finishedAt: new Date().toISOString(),
    summary,
    outcome,
    helperReadiness: submission.parsed?.readiness,
  });
  if (!args.keepArtifact && outcome.taskId) {
    const candidatePath = resolve('results/task-artifacts', outcome.taskId);
    if (existsSync(candidatePath)) {
      try {
        rmSync(candidatePath, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; cleanup failure must not flip the exit code
      }
    }
  }
  process.exit(exitCode);
}

main();
