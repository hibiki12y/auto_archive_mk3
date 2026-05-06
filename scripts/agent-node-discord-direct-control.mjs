#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CHANNEL_ID = '1483826614335836170';
const DEFAULT_GUILD_ID = '1476114038743367713';
const DEFAULT_SSH_HOST = 'chevalgrand@100.85.156.3';
const DEFAULT_SSH_KEY = 'resource/ssh/key';
const DEFAULT_REMOTE_ROOT = '/Users/chevalgrand/auto-archive-apple';
const DEFAULT_REMOTE_NODE = '/Users/chevalgrand/.nvm/versions/node/v24.14.0/bin/node';
const DEFAULT_BRIDGE_PATH =
  '/Users/chevalgrand/Library/Application Support/AutoArchiveMacWrapper/desktop-control-bridge.json';

const USAGE = `Usage:
  pnpm discord:gui-ask -- --channel-id <id> --message "<instruction>" [options]
  node scripts/agent-node-discord-direct-control.mjs --mode slash-ask --message "<instruction>" [options]
  node scripts/agent-node-discord-direct-control.mjs --mode slash-status --message "<task_id>" [options]
  node scripts/agent-node-discord-direct-control.mjs --mode slash-cancel --message "<task_id>" [options]
  node scripts/agent-node-discord-direct-control.mjs --mode slash-focus --message "<task_id>" [options]
  node scripts/agent-node-discord-direct-control.mjs --mode slash-unfocus [options]
  node scripts/agent-node-discord-direct-control.mjs --mode natural-ask --message "<instruction>" [options]

Required:
  --message, --instruction <text>   Instruction to fill into the /ask instruction option.
                                   In --mode message, this is the full user message.
                                   In --mode natural-ask, this is addressed as a natural chat request.
                                   In --mode slash-focus, this is the task_id to bind.
                                   In --mode slash-unfocus, --message is not required.

Common options:
  --mode <slash-ask|slash-status|slash-cancel|slash-focus|slash-unfocus|message|natural-ask>
                                   Default: slash-ask.
  --mention-user-id <id>            Bot user id to mention for --mode natural-ask.
                                   Defaults to AUTO_ARCHIVE_DISCORD_BOT_USER_ID
                                   or AUTO_ARCHIVE_DISCORD_APPLICATION_ID.
  --natural-address <text>          Explicit address prefix for --mode natural-ask.
                                   Overrides mention-based addressing.
  --marker <text>                   Optional evidence marker.
  --expect-author <discord_id>      Expected bot author id for polling.
  --expect-task-id <task_id>         Correlate REST polling to this task id.
                                   Defaults to the first discord-task-* in --message.
  --guild-id <id>                   Defaults to AUTO_ARCHIVE_DISCORD_GUILD_ID or ${DEFAULT_GUILD_ID}.
  --channel-id <id>                 Defaults to AUTO_ARCHIVE_E2E_TEST_CHANNEL_ID,
                                   AUTO_ARCHIVE_DISCORD_CHANNEL_ID, or ${DEFAULT_CHANNEL_ID}.
  --ssh-host <host>                 Default: ${DEFAULT_SSH_HOST}.
  --ssh-key <path>                  Default: ${DEFAULT_SSH_KEY}.
  --input-x <n> --input-y <n>       Discord composer click coordinates. Defaults: 447, 1015.
  --command-x <n> --command-y <n>   /ask autocomplete row click coordinates. Defaults: 392, 831.
  --polls <n> --poll-ms <n>         REST observation loop. Defaults: 12, 5000.
  --poll-mode <auto|marker|after-start|task-lifecycle|command-response>
                                   Default: auto; slash ask/natural ask use task-lifecycle;
                                   slash status/cancel use command-response.
  --command-select <click|return>   Slash command autocomplete selection mode.
                                   Default: return.
  --observe-mode <see|image|both|none>
                                   Post-submit GUI observation mode. Default: see.
                                   image captures a PNG through Peekaboo instead of OCR text.
  --image-capture-path <remote_path>
                                   Remote PNG path for --observe-mode image|both.
                                   Defaults to /tmp/auto-archive-discord-observe-<timestamp>.png.
  --image-output <local_path>        Copy the remote PNG capture to this local path with scp.
  --image-capture-delay-ms <ms>     Additional wait before the image capture (after the see
                                   observation, if any). Helps capture the bot's terminal ack
                                   when --observe-mode image|both is used. Default: 0.
  --debug-steps                    Include failed fallback attempts in remote control JSON.
  --no-rest                         Skip Discord REST polling; returns GUI-control result only.
  --dry-run                         Print planned sanitized configuration; do not SSH or call Discord.
  --probe                           Probe staged live readiness only; no Discord submit occurs.
  --help                            Show this help.

Confirmed slash-command sequence:
  focus channel -> click composer -> type /ask -> select /ask autocomplete item
  -> fill instruction -> Return. Typing "/ask <instruction>" as one message is intentionally not used.
`;

function readArgValue(argv, index, arg) {
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex >= 0) {
    return { value: arg.slice(equalsIndex + 1), nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function parseNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    mode: 'slash-ask',
    slashCommand: '/ask',
    inputX: 447,
    inputY: 1015,
    commandX: 392,
    commandY: 831,
    initialWaitMs: 1200,
    autocompleteWaitMs: 800,
    afterSubmitWaitMs: 300,
    imageCaptureDelayMs: 0,
    polls: 12,
    pollMs: 5000,
    pollMode: 'auto',
    commandSelect: 'return',
    observeMode: 'see',
    envFile: '.env',
    botTokenEnv: 'AUTO_ARCHIVE_DISCORD_TOKEN',
    remoteRoot: DEFAULT_REMOTE_ROOT,
    remoteNode: DEFAULT_REMOTE_NODE,
    bridgePath: DEFAULT_BRIDGE_PATH,
    debugSteps: false,
    dryRun: false,
    probe: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--probe') {
      args.probe = true;
      continue;
    }
    if (arg === '--debug-steps') {
      args.debugSteps = true;
      continue;
    }
    if (arg === '--no-rest') {
      args.polls = 0;
      continue;
    }

    const assign = (key, transform = (value) => value) => {
      const parsed = readArgValue(argv, i, arg);
      args[key] = transform(parsed.value);
      i = parsed.nextIndex;
    };

    if (arg === '--message' || arg.startsWith('--message=')) assign('message');
    else if (arg === '--instruction' || arg.startsWith('--instruction=')) assign('message');
    else if (arg === '--marker' || arg.startsWith('--marker=')) assign('marker');
    else if (arg === '--expect-author' || arg.startsWith('--expect-author=')) assign('expectAuthor');
    else if (arg === '--expect-task-id' || arg.startsWith('--expect-task-id=')) assign('expectTaskId');
    else if (arg === '--channel-id' || arg.startsWith('--channel-id=')) assign('channelId');
    else if (arg === '--guild-id' || arg.startsWith('--guild-id=')) assign('guildId');
    else if (arg === '--ssh-host' || arg.startsWith('--ssh-host=')) assign('sshHost');
    else if (arg === '--ssh-key' || arg.startsWith('--ssh-key=')) assign('sshKey');
    else if (arg === '--mode' || arg.startsWith('--mode=')) assign('mode');
    else if (arg === '--mention-user-id' || arg.startsWith('--mention-user-id=')) assign('mentionUserId');
    else if (arg === '--natural-address' || arg.startsWith('--natural-address=')) assign('naturalAddress');
    else if (arg === '--command' || arg.startsWith('--command=')) assign('slashCommand');
    else if (arg === '--input-x' || arg.startsWith('--input-x=')) assign('inputX', (v) => parseNumber(v, '--input-x'));
    else if (arg === '--input-y' || arg.startsWith('--input-y=')) assign('inputY', (v) => parseNumber(v, '--input-y'));
    else if (arg === '--command-x' || arg.startsWith('--command-x=')) assign('commandX', (v) => parseNumber(v, '--command-x'));
    else if (arg === '--command-y' || arg.startsWith('--command-y=')) assign('commandY', (v) => parseNumber(v, '--command-y'));
    else if (arg === '--polls' || arg.startsWith('--polls=')) assign('polls', (v) => parseNonNegativeInteger(v, '--polls'));
    else if (arg === '--poll-ms' || arg.startsWith('--poll-ms=')) assign('pollMs', (v) => parsePositiveInteger(v, '--poll-ms'));
    else if (arg === '--poll-mode' || arg.startsWith('--poll-mode=')) assign('pollMode');
    else if (arg === '--command-select' || arg.startsWith('--command-select=')) assign('commandSelect');
    else if (arg === '--observe-mode' || arg.startsWith('--observe-mode=')) assign('observeMode');
    else if (arg === '--image-capture-path' || arg.startsWith('--image-capture-path=')) assign('imageCapturePath');
    else if (arg === '--image-output' || arg.startsWith('--image-output=')) assign('imageOutput');
    else if (arg === '--image-capture-delay-ms' || arg.startsWith('--image-capture-delay-ms=')) assign('imageCaptureDelayMs', (v) => parseNonNegativeInteger(v, '--image-capture-delay-ms'));
    else if (arg === '--initial-wait-ms' || arg.startsWith('--initial-wait-ms=')) assign('initialWaitMs', (v) => parsePositiveInteger(v, '--initial-wait-ms'));
    else if (arg === '--autocomplete-wait-ms' || arg.startsWith('--autocomplete-wait-ms=')) assign('autocompleteWaitMs', (v) => parsePositiveInteger(v, '--autocomplete-wait-ms'));
    else if (arg === '--after-submit-wait-ms' || arg.startsWith('--after-submit-wait-ms=')) assign('afterSubmitWaitMs', (v) => parsePositiveInteger(v, '--after-submit-wait-ms'));
    else if (arg === '--env-file' || arg.startsWith('--env-file=')) assign('envFile');
    else if (arg === '--bot-token-env' || arg.startsWith('--bot-token-env=')) assign('botTokenEnv');
    else if (arg === '--remote-root' || arg.startsWith('--remote-root=')) assign('remoteRoot');
    else if (arg === '--remote-node' || arg.startsWith('--remote-node=')) assign('remoteNode');
    else if (arg === '--bridge-path' || arg.startsWith('--bridge-path=')) assign('bridgePath');
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.help) {
    return args;
  }
  if (
    args.mode !== 'slash-ask' &&
    args.mode !== 'slash-status' &&
    args.mode !== 'slash-cancel' &&
    args.mode !== 'slash-focus' &&
    args.mode !== 'slash-unfocus' &&
    args.mode !== 'message' &&
    args.mode !== 'natural-ask'
  ) {
    throw new Error('--mode must be one of: slash-ask, slash-status, slash-cancel, slash-focus, slash-unfocus, message, natural-ask');
  }
  if (!['auto', 'marker', 'after-start', 'task-lifecycle', 'command-response'].includes(args.pollMode)) {
    throw new Error('--poll-mode must be one of: auto, marker, after-start, task-lifecycle, command-response');
  }
  if (!['click', 'return'].includes(args.commandSelect)) {
    throw new Error('--command-select must be one of: click, return');
  }
  if (!['see', 'image', 'both', 'none'].includes(args.observeMode)) {
    throw new Error('--observe-mode must be one of: see, image, both, none');
  }
  if (
    !args.probe &&
    args.mode !== 'slash-unfocus' &&
    (!args.message || args.message.trim().length === 0)
  ) {
    throw new Error('--message/--instruction is required');
  }
  if (!args.slashCommand.startsWith('/')) {
    args.slashCommand = `/${args.slashCommand}`;
  }
  if (args.mode === 'slash-status' && args.slashCommand === '/ask') {
    args.slashCommand = '/status';
  }
  if (args.mode === 'slash-cancel' && args.slashCommand === '/ask') {
    args.slashCommand = '/cancel';
  }
  if (args.mode === 'slash-focus' && args.slashCommand === '/ask') {
    args.slashCommand = '/focus';
  }
  if (args.mode === 'slash-unfocus' && args.slashCommand === '/ask') {
    args.slashCommand = '/unfocus';
  }
  return args;
}

function looksNaturallyAddressed(message) {
  return /^\s*(?:(?:hey|hi|hello|ok|okay|안녕|저기)\s+)?(?:<@!?\d+>|arona|plana|아로나|플라나)(?=$|\s|[,，:：;；.!?！？\-–—]|야|아|에게|한테|님)/iu.test(
    message,
  );
}

function buildNaturalAskMessage(instruction, naturalAddress) {
  const trimmedInstruction = instruction.trim();
  if (looksNaturallyAddressed(trimmedInstruction)) {
    return trimmedInstruction;
  }

  const address = naturalAddress.trim();
  if (!address) {
    throw new Error('--natural-address must not be empty in --mode natural-ask');
  }

  return `${address} ${trimmedInstruction}`;
}

function resolveNaturalAskAddress(args, mergedEnv) {
  if (args.naturalAddress !== undefined) {
    return args.naturalAddress;
  }
  const mentionUserId =
    args.mentionUserId ??
    mergedEnv.AUTO_ARCHIVE_DISCORD_BOT_USER_ID ??
    mergedEnv.AUTO_ARCHIVE_DISCORD_APPLICATION_ID;
  if (mentionUserId === undefined || mentionUserId.trim().length === 0) {
    throw new Error(
      '--mode natural-ask requires --mention-user-id, AUTO_ARCHIVE_DISCORD_BOT_USER_ID, or AUTO_ARCHIVE_DISCORD_APPLICATION_ID',
    );
  }
  return `<@${mentionUserId.trim()}>`;
}

function loadEnvFile(path = '.env') {
  if (!existsSync(path)) {
    return {};
  }
  const entries = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function sanitizeToolValue(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= 500 ? text : `${text.slice(0, 500)}…`;
}

const TIMEOUT_PATTERN = /\b(?:timed out|timeout|ETIMEDOUT)\b/iu;

function mapReadinessRemediations(error) {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const message = typeof error?.message === 'string' ? error.message : String(error?.message ?? '');
  const domain = typeof error?.domain === 'string' ? error.domain : undefined;
  const hints = [];

  if (code === 'PEEKABOO_LIST_TOOLS_FAILED') {
    hints.push(
      'Run this helper with --probe before live submit to verify proxy tool-list readiness without mutating Discord.',
      'Refresh or recreate desktop-control-bridge.json on the macOS host, then confirm it references the current Peekaboo proxy socket.',
      'Restart the Peekaboo proxy or bridge service if tool-list requests continue to time out.',
    );
  }

  if (
    domain === 'TRANSPORT' ||
    TIMEOUT_PATTERN.test(message) ||
    /ECONNREFUSED|ENOENT|socket/i.test(message)
  ) {
    hints.push(
      'Verify SSH reachability, remote host load, and that the Peekaboo proxy socket from the bridge file is reachable.',
      'Retry after the transport path recovers; timeout-like transport failures are usually transient.',
    );
  }

  if (/ENOENT|not found/i.test(message)) {
    hints.push(
      'Confirm the bridge file and referenced proxy socket path both exist on the remote host.',
    );
  }

  if (/ECONNREFUSED|connection refused/i.test(message)) {
    hints.push(
      'Start or restart the Peekaboo proxy server on the remote host before retrying.',
    );
  }

  if (hints.length === 0) {
    hints.push(
      'Re-run with --probe to isolate readiness failures before attempting live Discord submission.',
    );
  }

  return [...new Set(hints)];
}

function normalizeReadinessError(error) {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (typeof error === 'string') {
    return {
      message: error,
      remediations: mapReadinessRemediations({ message: error }),
    };
  }
  const message =
    typeof error.message === 'string'
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  if (!message) {
    return undefined;
  }
  const normalized = {
    message,
    remediations: mapReadinessRemediations(error),
  };
  if (typeof error.code === 'string') {
    normalized.code = error.code;
  }
  if (typeof error.domain === 'string') {
    normalized.domain = error.domain;
  }
  if (typeof error.retryable === 'boolean') {
    normalized.retryable = error.retryable;
  }
  return normalized;
}

function hasStrongEvidenceSignal(observation, expectedTaskId) {
  if (!observation) {
    return false;
  }
  if (
    expectedTaskId !== undefined &&
    observation.taskId !== undefined &&
    observation.taskId === expectedTaskId
  ) {
    return true;
  }
  if (expectedTaskId === undefined && observation.taskId !== undefined) {
    return true;
  }
  return (
    observation.matchedOn?.some((signal) => signal === 'task-id' || signal === 'marker') ??
    false
  );
}

function buildEvidenceStage(observation, status, summary) {
  return {
    status,
    summary,
    observedAt: observation?.observedAt,
    source: observation?.source,
    messageId: observation?.messageId,
    authorId: observation?.authorId,
    taskId: observation?.taskId,
    marker: observation?.marker,
    matchedOn: observation?.matchedOn,
  };
}

function buildEvidenceAudit({
  phase,
  marker,
  expectedTaskId,
  submitAttempted = false,
  restObservationAttempted = false,
  ack,
  matchedReply,
  relatedReplyCount = 0,
}) {
  const acknowledgement = ack ?? matchedReply;
  const submit = buildEvidenceStage(
    undefined,
    phase !== 'live' ? 'skipped' : submitAttempted ? 'attempted' : 'missing',
    phase !== 'live'
      ? 'No live Discord submission was attempted in this phase.'
      : submitAttempted
        ? 'Live Discord submit was attempted through the remote GUI path.'
        : 'Live Discord submit was not observed.',
  );
  const ackStatus =
    phase !== 'live'
      ? 'skipped'
      : !submitAttempted
        ? 'missing'
        : !restObservationAttempted
          ? 'missing'
          : acknowledgement === undefined
            ? relatedReplyCount > 0
              ? 'weak'
              : 'missing'
            : hasStrongEvidenceSignal(acknowledgement, expectedTaskId)
              ? 'captured'
              : 'weak';
  const matchedReplyStatus =
    phase !== 'live'
      ? 'skipped'
      : !submitAttempted
        ? 'missing'
        : !restObservationAttempted
          ? 'missing'
          : matchedReply === undefined
            ? relatedReplyCount > 0
              ? 'weak'
              : 'missing'
            : hasStrongEvidenceSignal(matchedReply, expectedTaskId)
              ? 'captured'
              : 'weak';
  const taskCorrelationObservation =
    matchedReply?.taskId !== undefined ? matchedReply : acknowledgement;
  const taskCorrelationStatus =
    phase !== 'live'
      ? 'skipped'
      : !submitAttempted
        ? 'missing'
        : taskCorrelationObservation === undefined
          ? relatedReplyCount > 0 && marker !== undefined
            ? 'weak'
            : 'missing'
          : hasStrongEvidenceSignal(taskCorrelationObservation, expectedTaskId)
            ? 'captured'
            : 'weak';
  return {
    marker,
    expectedTaskId,
    submit,
    taskCorrelation: buildEvidenceStage(
      taskCorrelationObservation,
      taskCorrelationStatus,
      taskCorrelationStatus === 'captured'
        ? 'Task correlation was captured from acknowledgement or reply evidence.'
        : taskCorrelationStatus === 'weak'
          ? 'Task correlation relied on indirect evidence such as marker-only or timing-only matches.'
          : taskCorrelationStatus === 'missing'
            ? 'No task-correlated acknowledgement or reply evidence was captured.'
            : 'Task correlation was skipped outside live execution.',
    ),
    ack: buildEvidenceStage(
      acknowledgement,
      ackStatus,
      ackStatus === 'captured'
        ? 'Acknowledgement evidence was captured with task-id or marker correlation.'
        : ackStatus === 'weak'
          ? acknowledgement === undefined
            ? 'Bot replies were observed after submit, but no acknowledgement could be strongly correlated.'
            : 'Acknowledgement evidence was observed, but only indirect correlation signals were available.'
          : ackStatus === 'missing'
            ? restObservationAttempted
              ? 'No acknowledgement evidence was captured after live submit.'
              : 'REST observation was skipped, so acknowledgement evidence could not be captured.'
            : 'Acknowledgement capture was skipped outside live execution.',
    ),
    matchedReply: buildEvidenceStage(
      matchedReply,
      matchedReplyStatus,
      matchedReplyStatus === 'captured'
        ? 'Matched reply evidence was captured with task-id or marker correlation.'
        : matchedReplyStatus === 'weak'
          ? matchedReply === undefined
            ? 'Related replies were observed after submit, but none satisfied the matched-reply gate.'
            : 'Matched reply evidence was observed, but only indirect correlation signals were available.'
          : matchedReplyStatus === 'missing'
            ? restObservationAttempted
              ? 'No matched reply evidence was captured after live submit.'
              : 'REST observation was skipped, so matched-reply evidence could not be captured.'
            : 'Matched-reply capture was skipped outside live execution.',
    ),
  };
}

function resolveProxyReadinessFields({
  phase,
  proxyReady,
  probeProxyReady,
  liveProxyReady,
}) {
  const resolvedProbeProxyReady =
    probeProxyReady ?? (phase === 'probe' ? proxyReady : undefined);
  const resolvedLiveProxyReady =
    liveProxyReady ?? (phase === 'live' ? proxyReady : undefined);
  const phaseSpecificProxyReady =
    phase === 'probe'
      ? resolvedProbeProxyReady
      : phase === 'live'
        ? resolvedLiveProxyReady
        : undefined;

  return {
    proxyStatus:
      phase === 'dry-run'
        ? 'unknown'
        : phaseSpecificProxyReady === true
          ? 'ready'
          : phaseSpecificProxyReady === false
            ? 'failed'
            : 'unknown',
    proxyReady: phaseSpecificProxyReady === true,
    probeProxyReady: resolvedProbeProxyReady === true,
    liveProxyReady: resolvedLiveProxyReady === true,
  };
}

function buildReadinessReport({
  phase,
  configOk = true,
  sshOk,
  bridgePresent,
  proxyReady,
  probeProxyReady,
  liveProxyReady,
  submitAttempted = false,
  controlOk,
  restObservationAttempted,
  matchedReplyObserved = false,
  marker,
  expectedTaskId,
  ack,
  matchedReply,
  relatedReplyCount = 0,
  error,
}) {
  const normalizedError = normalizeReadinessError(error);
  const proxyReadiness = resolveProxyReadinessFields({
    phase,
    proxyReady,
    probeProxyReady,
    liveProxyReady,
  });
  matchedReplyObserved = matchedReply !== undefined || matchedReplyObserved === true;
  const configStatus = configOk === false ? 'failed' : 'ready';
  const sshStatus = phase === 'dry-run' ? 'unknown' : sshOk === true ? 'ready' : sshOk === false ? 'failed' : 'unknown';
  const bridgeStatus = phase === 'dry-run' ? 'unknown' : bridgePresent === true ? 'ready' : bridgePresent === false ? 'failed' : 'unknown';
  const proxyStatus = proxyReadiness.proxyStatus;
  const prereqsReady = [configStatus, sshStatus, bridgeStatus, proxyStatus].every((status) => status === 'ready');
  const prereqsFailed = [configStatus, sshStatus, bridgeStatus, proxyStatus].some((status) => status === 'failed');
  const evidence = buildEvidenceAudit({
    phase,
    marker,
    expectedTaskId,
    submitAttempted,
    restObservationAttempted,
    ack,
    matchedReply,
    relatedReplyCount,
  });

  let submitStatus;
  if (phase === 'dry-run') {
    submitStatus = 'unknown';
  } else if (phase === 'probe') {
    submitStatus = prereqsReady ? 'ready' : prereqsFailed ? 'failed' : 'unknown';
  } else if (submitAttempted || controlOk === true) {
    submitStatus = 'ready';
  } else {
    submitStatus = prereqsFailed ? 'failed' : 'unknown';
  }

  let liveStatus;
  if (phase !== 'live') {
    liveStatus = 'skipped';
  } else if (controlOk !== true) {
    liveStatus = 'failed';
  } else if (restObservationAttempted === false) {
    liveStatus = 'unknown';
  } else {
    liveStatus = matchedReplyObserved ? 'ready' : 'failed';
  }

  let errorLabel;
  if (normalizedError) {
    if (['PEEKABOO_LIST_TOOLS_FAILED', 'PEEKABOO_INIT_FAILED', 'PEEKABOO_NOT_READY'].includes(normalizedError.code)) {
      errorLabel = 'PROXY_READY';
    } else if (/ssh|connecttimeout|host key|permission denied/i.test(normalizedError.message)) {
      errorLabel = 'SSH_OK';
    } else {
      errorLabel = phase === 'live' && submitAttempted ? 'LIVE_OK' : 'SUBMIT_READY';
    }
  }

  const checks = [
    {
      label: 'CONFIG_OK',
      status: configStatus,
      summary:
        configStatus === 'ready'
          ? 'Local helper configuration parsed and sanitized.'
          : 'Local helper configuration was invalid.',
    },
    {
      label: 'SSH_OK',
      status: sshStatus,
      summary:
        sshStatus === 'ready'
          ? 'SSH reachability was confirmed for the remote macOS host.'
          : sshStatus === 'failed'
            ? 'SSH reachability failed before remote GUI control could continue.'
            : 'SSH reachability was not checked in this execution mode.',
    },
    {
      label: 'BRIDGE_PRESENT',
      status: bridgeStatus,
      summary:
        bridgeStatus === 'ready'
          ? 'desktop-control-bridge.json was present and readable.'
          : bridgeStatus === 'failed'
            ? 'desktop-control-bridge.json was missing or unreadable.'
            : 'Bridge presence was not confirmed in this execution mode.',
    },
    {
      label: 'PROXY_READY',
      status: proxyStatus,
      summary:
        phase === 'dry-run'
          ? 'Dry-run preview does not confirm proxy readiness.'
          : phase === 'probe'
            ? proxyStatus === 'ready'
              ? 'Peekaboo proxy initialize/list-tools readiness succeeded.'
              : proxyStatus === 'failed'
                ? 'Peekaboo proxy initialize/list-tools readiness failed.'
                : 'Peekaboo proxy initialize/list-tools readiness was not confirmed.'
            : proxyStatus === 'ready'
              ? 'Live-control proxy readiness was reported ready.'
              : proxyStatus === 'failed'
                ? 'Live-control proxy readiness was reported failed.'
                : 'Live-control proxy readiness was not confirmed.',
    },
    {
      label: 'SUBMIT_READY',
      status: submitStatus,
      summary:
        phase === 'dry-run'
          ? 'Dry-run preview does not verify whether a live submit would succeed.'
          : phase === 'probe'
            ? submitStatus === 'ready'
              ? 'Probe verified the pre-submit gates needed for live Discord control.'
              : submitStatus === 'failed'
                ? 'Probe failed before the live submit gate was considered ready.'
                : 'Probe could not prove submit readiness.'
            : submitStatus === 'ready'
              ? 'The run reached or passed the live submit gate.'
              : submitStatus === 'failed'
                ? 'The run failed before reaching the live submit gate.'
                : 'Submit readiness remained unknown.',
    },
    {
      label: 'LIVE_OK',
      status: liveStatus,
      summary:
        phase !== 'live'
          ? 'No live Discord submission was attempted.'
          : liveStatus === 'ready'
            ? 'Live submission and matched-reply evidence both succeeded.'
            : liveStatus === 'failed'
              ? 'Live evidence did not satisfy the matched-reply gate.'
              : 'Live submission ran, but matched-reply evidence was not collected.',
    },
  ].map((check) =>
    check.label === errorLabel && normalizedError
      ? { ...check, error: normalizedError }
      : check,
  );

  const overallStatus =
    phase === 'dry-run'
      ? 'unknown'
      : phase === 'probe'
        ? submitStatus === 'ready'
          ? 'ready'
          : submitStatus
        : liveStatus === 'ready'
          ? 'ready'
          : liveStatus === 'failed' || submitStatus === 'failed'
            ? 'failed'
            : 'unknown';

  const highestReady =
    [...checks].reverse().find((check) => check.status === 'ready')?.label ?? null;

  return {
    phase,
    overallStatus,
    highestReady,
    proxyReady: proxyReadiness.proxyReady,
    probeProxyReady: proxyReadiness.probeProxyReady,
    liveProxyReady: proxyReadiness.liveProxyReady,
    submitReady: submitStatus === 'ready',
    liveOk: liveStatus === 'ready',
    liveSubmitPerformed: phase === 'live' && submitAttempted === true,
    matchedReplyObserved,
    evidence,
    checks,
    summary:
      phase === 'dry-run'
        ? 'Dry-run preview only; live readiness was not probed and no Discord submission occurred.'
        : phase === 'probe'
          ? submitStatus === 'ready'
            ? 'Probe confirmed submit readiness without performing a live Discord submission.'
            : overallStatus === 'failed'
              ? 'Probe found a readiness failure before live Discord submission.'
              : 'Probe completed without enough evidence to declare live submit readiness.'
          : liveStatus === 'ready'
            ? 'Live control reached the expected evidence gate.'
            : submitStatus === 'ready'
              ? 'Live submit path ran, but end-to-end evidence did not satisfy the matched-reply gate.'
              : 'Live run stopped before a fully ready Discord submission path was confirmed.',
  };
}

function parseRemotePayload(stdout) {
  const parsed = parseRemoteJson(stdout);
  return [...parsed].reverse().find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && !('raw' in entry)) ?? null;
}

function sanitizeSshFailure(stderr) {
  const message = sanitizeToolValue(stderr) ?? 'SSH command failed before the remote helper could complete.';
  return {
    code: 'SSH_REMOTE_COMMAND_FAILED',
    message,
    domain: 'TRANSPORT',
    retryable: true,
  };
}

export function buildRemoteScript() {
  return String.raw`
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PeekabooProxyClient } from './compute-node/dist/apple/peekaboo-proxy-client.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const decode = (name) => Buffer.from(process.env[name] ?? '', 'base64').toString('utf8');
const message = decode('MESSAGE_B64');
const channelId = process.env.DISCORD_CHANNEL_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const mode = process.env.CONTROL_MODE;
const slashCommand = process.env.SLASH_COMMAND ?? '/ask';
const commandSelect = process.env.COMMAND_SELECT ?? 'return';
const bridgePath = decode('BRIDGE_PATH_B64');
const inputX = Number(process.env.INPUT_X);
const inputY = Number(process.env.INPUT_Y);
const commandX = Number(process.env.COMMAND_X);
const commandY = Number(process.env.COMMAND_Y);
const initialWaitMs = Number(process.env.INITIAL_WAIT_MS);
const autocompleteWaitMs = Number(process.env.AUTOCOMPLETE_WAIT_MS);
const afterSubmitWaitMs = Number(process.env.AFTER_SUBMIT_WAIT_MS);
const imageCaptureDelayMs = Math.max(0, Number(process.env.IMAGE_CAPTURE_DELAY_MS ?? 0));
const observeMode = process.env.OBSERVE_MODE ?? 'see';
const imageCapturePathOverride = decode('IMAGE_CAPTURE_PATH_B64');
const debugSteps = process.env.DEBUG_STEPS === '1';
const steps = [];
const bridge = { path: bridgePath, exists: false, tokenPresent: false };
const proxy = { ready: false, toolCount: 0, toolNames: [] };
let submitAttempted = false;
let imageCapture = null;

function summarize(value) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= 500 ? text : text.slice(0, 500) + '…';
}

function resultError(result) {
  return summarize(result?.error ?? result);
}

function mapRemediations(error) {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const message = typeof error?.message === 'string' ? error.message : String(error?.message ?? '');
  const domain = typeof error?.domain === 'string' ? error.domain : undefined;
  const hints = [];
  if (code === 'PEEKABOO_LIST_TOOLS_FAILED') {
    hints.push(
      'Run the local helper with --probe before live submit to verify proxy tool-list readiness.',
      'Refresh or recreate desktop-control-bridge.json on the macOS host, then confirm it points at the current Peekaboo proxy socket.',
      'Restart the Peekaboo proxy or bridge service if tool-list requests keep timing out.',
    );
  }
  if (
    domain === 'TRANSPORT' ||
    /timed out|timeout|ETIMEDOUT|ECONNREFUSED|ENOENT|socket/i.test(message)
  ) {
    hints.push(
      'Verify the Peekaboo proxy socket from the bridge file is reachable on the remote host.',
      'Retry after the transport path recovers; timeout-like transport failures are usually transient.',
    );
  }
  if (/ENOENT|not found/i.test(message)) {
    hints.push('Confirm the bridge file and referenced proxy socket path both exist on the remote host.');
  }
  if (/ECONNREFUSED|connection refused/i.test(message)) {
    hints.push('Start or restart the Peekaboo proxy server on the remote host before retrying.');
  }
  return [...new Set(hints.length > 0 ? hints : ['Re-run the local helper with --probe before attempting another live submission.'])];
}

function normalizeErrorPayload(error) {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (typeof error === 'string') {
    return { message: error, remediations: mapRemediations({ message: error }) };
  }
  const payload = {
    message:
      typeof error.message === 'string'
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error),
    remediations: mapRemediations(error),
  };
  if (typeof error.code === 'string') payload.code = error.code;
  if (typeof error.domain === 'string') payload.domain = error.domain;
  if (typeof error.retryable === 'boolean') payload.retryable = error.retryable;
  return payload;
}

function pushStep(step, options = {}) {
  if (!options.debugOnly || debugSteps) {
    steps.push(step);
  }
}

function emitAndExit(payload, status) {
  console.log(JSON.stringify({ bridge, proxy, submitAttempted, ...payload }));
  process.exit(status);
}

async function requiredCall(client, tool, args, stage) {
  const result = await client.callTool(tool, args);
  pushStep({ stage, tool, ok: !result.isErr(), text: result.isErr() ? undefined : summarize(result.value?.text), error: result.isErr() ? resultError(result) : undefined });
  if (result.isErr()) {
    emitAndExit({ ok: false, stage, steps, error: resultError(result) }, 10);
  }
  return result;
}

async function optionalCall(client, tool, args, stage) {
  const result = await client.callTool(tool, args);
  pushStep({
    stage,
    tool,
    optional: true,
    ok: !result.isErr(),
    degraded: result.isErr(),
    text: result.isErr() ? undefined : summarize(result.value?.text),
    error: result.isErr() ? resultError(result) : undefined,
  }, { debugOnly: result.isErr() });
  if (result.isErr() && !debugSteps) {
    pushStep({ stage, tool, optional: true, ok: false, degraded: true, note: 'optional fallback skipped or unavailable' });
  }
  return result;
}

async function capturePostSubmitImage(client) {
  const imagePath =
    imageCapturePathOverride && imageCapturePathOverride.trim().length > 0
      ? imageCapturePathOverride
      : '/tmp/auto-archive-discord-observe-' + Date.now() + '.png';
  const result = await client.callTool('image', {
    path: imagePath,
    format: 'png',
  });
  imageCapture = {
    path: imagePath,
    ok: !result.isErr(),
    format: 'png',
    captureTarget: 'default-after-discord-focus',
    error: result.isErr() ? resultError(result) : undefined,
    text: result.isErr() ? undefined : summarize(result.value?.text),
  };
  pushStep({
    stage: 'capture-after-submit-image',
    tool: 'image',
    optional: true,
    ok: imageCapture.ok,
    degraded: !imageCapture.ok,
    imagePath,
    text: imageCapture.text,
    error: imageCapture.error,
  }, { debugOnly: !imageCapture.ok });
  if (!imageCapture.ok && !debugSteps) {
    pushStep({ stage: 'capture-after-submit-image', tool: 'image', optional: true, ok: false, degraded: true, imagePath, note: 'image capture skipped or unavailable' });
  }
  return imageCapture;
}

async function clickAt(client, x, y, stage) {
  const attempts = [
    { coords: x + ',' + y },
    { coords: { x, y } },
    { coords: [x, y] },
    { x, y },
  ];
  let lastError;
  let attemptCount = 0;
  for (const args of attempts) {
    attemptCount += 1;
    const result = await client.callTool('click', args);
    pushStep({
      stage,
      tool: 'click',
      argsShape: Object.keys(args).join(','),
      attempt: attemptCount,
      ok: !result.isErr(),
      text: result.isErr() ? undefined : summarize(result.value?.text),
      error: result.isErr() ? resultError(result) : undefined,
    }, { debugOnly: true });
    if (!result.isErr()) {
      if (!debugSteps) {
        pushStep({
          stage,
          tool: 'click',
          argsShape: Object.keys(args).join(','),
          attempts: attemptCount,
          ok: true,
          degraded: attemptCount > 1,
          text: summarize(result.value?.text),
        });
      }
      return result;
    }
    lastError = resultError(result);
  }
  emitAndExit({ ok: false, stage, steps, error: lastError }, 10);
}

async function pasteOrType(client, text, stage) {
  try {
    execFileSync('/usr/bin/pbcopy', [], { input: text });
    pushStep({ stage: stage + ':clipboard-copy', tool: 'pbcopy', ok: true, method: 'system-clipboard' });
    let result = await client.callTool('hotkey', { key: 'cmd,v', keys: 'cmd,v' });
    pushStep({
      stage,
      tool: 'hotkey',
      ok: !result.isErr(),
      method: 'system-clipboard',
      text: result.isErr() ? undefined : summarize(result.value?.text),
      error: result.isErr() ? resultError(result) : undefined,
    });
    if (!result.isErr()) {
      return 'system-clipboard';
    }
  } catch (error) {
    pushStep({
      stage: stage + ':clipboard-unavailable',
      tool: 'pbcopy',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, { debugOnly: true });
  }

  let result = await client.callTool('paste', { app: 'Discord', text });
  if (!result.isErr()) {
    pushStep({ stage, tool: 'paste', ok: true, method: 'paste', degraded: true, fallbackFrom: 'system-clipboard', text: summarize(result.value?.text) });
    return 'paste';
  }
  pushStep({ stage: stage + ':paste-unavailable', tool: 'paste', ok: false, error: resultError(result) }, { debugOnly: true });

  result = await client.callTool('type', { text, delay: 1, profile: 'linear' });
  pushStep({
    stage,
    tool: 'type',
    ok: !result.isErr(),
    method: 'type-fallback',
    degraded: true,
    fallbackFrom: 'paste',
    text: result.isErr() ? undefined : summarize(result.value?.text),
    error: result.isErr() ? resultError(result) : undefined,
  });
  if (result.isErr()) {
    emitAndExit({ ok: false, stage, steps, error: resultError(result) }, 11);
  }
  return 'type-fallback';
}

function readProxy() {
  bridge.exists = true;
  const parsed = JSON.parse(readFileSync(bridgePath, 'utf8'));
  const proxyConfig = parsed?.peekabooProxy;
  if (
    !proxyConfig ||
    typeof proxyConfig.socketPath !== 'string' ||
    typeof proxyConfig.token !== 'string'
  ) {
    throw { code: 'PEEKABOO_INIT_FAILED', message: 'desktop-control-bridge.json is missing peekabooProxy socket/token fields.', domain: 'EXECUTION', retryable: false };
  }
  bridge.tokenPresent = proxyConfig.token.length > 0;
  bridge.socketPath = proxyConfig.socketPath;
  return proxyConfig;
}

try {
  const proxyConfig = readProxy();
  const client = new PeekabooProxyClient({
    socketPath: proxyConfig.socketPath,
    token: proxyConfig.token,
    tokenRefresher: async () => readProxy(),
  });
  const init = await client.initialize();
  pushStep({ stage: 'initialize', ok: !init.isErr(), error: init.isErr() ? resultError(init) : undefined });
  if (init.isErr()) {
    emitAndExit({ ok: false, stage: 'initialize', steps, error: normalizeErrorPayload(init.error ?? init) }, 2);
  }
  proxy.ready = true;
  proxy.toolCount = Array.isArray(init.value) ? init.value.length : 0;
  proxy.toolNames = Array.isArray(init.value) ? init.value.map((tool) => tool?.name).filter((name) => typeof name === 'string') : [];

  execFileSync('/usr/bin/open', ['discord://-/channels/' + guildId + '/' + channelId]);
  pushStep({ stage: 'open-channel', ok: true });
  await sleep(initialWaitMs);
  await requiredCall(client, 'app', { action: 'focus', name: 'Discord' }, 'focus-discord');
  await optionalCall(client, 'hotkey', { key: 'Escape', keys: 'Escape' }, 'dismiss-overlays');
  await clickAt(client, inputX, inputY, 'click-composer');
  await optionalCall(client, 'hotkey', { key: 'cmd,a', keys: 'cmd,a' }, 'select-existing-draft');
  await optionalCall(client, 'hotkey', { key: 'Backspace', keys: 'Backspace' }, 'clear-existing-draft');

  let method;
  if (
    mode === 'slash-ask' ||
    mode === 'slash-status' ||
    mode === 'slash-cancel' ||
    mode === 'slash-focus' ||
    mode === 'slash-unfocus'
  ) {
    await requiredCall(client, 'type', { text: slashCommand, delay: 1, profile: 'linear' }, 'type-slash-command');
    await sleep(autocompleteWaitMs);
    if (commandSelect === 'return') {
      await requiredCall(client, 'hotkey', { key: 'return', keys: 'return' }, 'select-slash-autocomplete-item');
    } else {
      await clickAt(client, commandX, commandY, 'click-slash-autocomplete-item');
    }
    await sleep(autocompleteWaitMs);
    if (mode === 'slash-unfocus') {
      method = 'no-instruction';
    } else {
      const slashInstruction =
        mode === 'slash-status' || mode === 'slash-cancel' || mode === 'slash-focus'
          ? ' ' + message.trim()
          : message;
      method = await pasteOrType(client, slashInstruction, 'fill-slash-instruction');
    }
  } else {
    method = await pasteOrType(client, message, 'fill-message');
  }

  await requiredCall(client, 'hotkey', { key: 'return', keys: 'return' }, 'submit-return');
  submitAttempted = true;
  await sleep(afterSubmitWaitMs);
  if (observeMode === 'see' || observeMode === 'both') {
    await optionalCall(client, 'see', {}, 'observe-after-submit');
  }
  if (observeMode === 'image' || observeMode === 'both') {
    if (imageCaptureDelayMs > 0) {
      pushStep({ stage: 'image-capture-delay', delayMs: imageCaptureDelayMs, ok: true });
      await sleep(imageCaptureDelayMs);
    }
    await capturePostSubmitImage(client);
  }

  emitAndExit({
    ok: true,
    mode,
    method,
    observeMode,
    imageCapture,
    slashCommandAutocompleteClicked:
      mode === 'slash-ask' ||
      mode === 'slash-status' ||
      mode === 'slash-cancel' ||
      mode === 'slash-focus' ||
      mode === 'slash-unfocus',
    steps,
  }, 0);
} catch (error) {
  emitAndExit({ ok: false, stage: 'remote-exception', steps, error: error instanceof Error ? error.message : String(error) }, 20);
}
`;
}

export function buildRemoteProbeScript() {
  return String.raw`
import { existsSync, readFileSync } from 'node:fs';
import { PeekabooProxyClient } from './compute-node/dist/apple/peekaboo-proxy-client.js';

const decode = (name) => Buffer.from(process.env[name] ?? '', 'base64').toString('utf8');
const bridgePath = decode('BRIDGE_PATH_B64');
const debugSteps = process.env.DEBUG_STEPS === '1';
const steps = [];
const bridge = { path: bridgePath, exists: false, tokenPresent: false };
const proxy = { ready: false, toolCount: 0, toolNames: [] };

function summarize(value) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= 500 ? text : text.slice(0, 500) + '…';
}

function mapRemediations(error) {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const message = typeof error?.message === 'string' ? error.message : String(error?.message ?? '');
  const domain = typeof error?.domain === 'string' ? error.domain : undefined;
  const hints = [];
  if (code === 'PEEKABOO_LIST_TOOLS_FAILED') {
    hints.push(
      'Run the local helper with --probe before live submit to verify proxy tool-list readiness.',
      'Refresh or recreate desktop-control-bridge.json on the macOS host, then confirm it points at the current Peekaboo proxy socket.',
      'Restart the Peekaboo proxy or bridge service if tool-list requests keep timing out.',
    );
  }
  if (
    domain === 'TRANSPORT' ||
    /timed out|timeout|ETIMEDOUT|ECONNREFUSED|ENOENT|socket/i.test(message)
  ) {
    hints.push(
      'Verify the Peekaboo proxy socket from the bridge file is reachable on the remote host.',
      'Retry after the transport path recovers; timeout-like transport failures are usually transient.',
    );
  }
  if (/ENOENT|not found/i.test(message)) {
    hints.push('Confirm the bridge file and referenced proxy socket path both exist on the remote host.');
  }
  if (/ECONNREFUSED|connection refused/i.test(message)) {
    hints.push('Start or restart the Peekaboo proxy server on the remote host before retrying.');
  }
  return [...new Set(hints.length > 0 ? hints : ['Re-run the local helper with --probe before attempting another live submission.'])];
}

function normalizeErrorPayload(error) {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (typeof error === 'string') {
    return { message: error, remediations: mapRemediations({ message: error }) };
  }
  const payload = {
    message:
      typeof error.message === 'string'
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error),
    remediations: mapRemediations(error),
  };
  if (typeof error.code === 'string') payload.code = error.code;
  if (typeof error.domain === 'string') payload.domain = error.domain;
  if (typeof error.retryable === 'boolean') payload.retryable = error.retryable;
  return payload;
}

function pushStep(step, options = {}) {
  if (!options.debugOnly || debugSteps) {
    steps.push(step);
  }
}

function emitAndExit(payload, status) {
  console.log(JSON.stringify({ bridge, proxy, submitAttempted: false, ...payload }));
  process.exit(status);
}

function readProxy() {
  bridge.exists = true;
  const parsed = JSON.parse(readFileSync(bridgePath, 'utf8'));
  const proxyConfig = parsed?.peekabooProxy;
  if (
    !proxyConfig ||
    typeof proxyConfig.socketPath !== 'string' ||
    typeof proxyConfig.token !== 'string'
  ) {
    throw { code: 'PEEKABOO_INIT_FAILED', message: 'desktop-control-bridge.json is missing peekabooProxy socket/token fields.', domain: 'EXECUTION', retryable: false };
  }
  bridge.tokenPresent = proxyConfig.token.length > 0;
  bridge.socketPath = proxyConfig.socketPath;
  return proxyConfig;
}

try {
  if (!existsSync(bridgePath)) {
    emitAndExit({
      ok: false,
      stage: 'bridge-presence',
      steps,
      error: normalizeErrorPayload({
        code: 'PEEKABOO_INIT_FAILED',
        message: 'desktop-control-bridge.json not found on remote host.',
        domain: 'EXECUTION',
        retryable: false,
      }),
    }, 3);
  }

  const proxyConfig = readProxy();
  pushStep({ stage: 'bridge-present', ok: true, socketPath: summarize(proxyConfig.socketPath), tokenPresent: bridge.tokenPresent });
  const client = new PeekabooProxyClient({
    socketPath: proxyConfig.socketPath,
    token: proxyConfig.token,
    tokenRefresher: async () => readProxy(),
  });

  const init = await client.initialize();
  pushStep({ stage: 'initialize', ok: !init.isErr(), error: init.isErr() ? summarize(init.error ?? init) : undefined });
  if (init.isErr()) {
    emitAndExit({ ok: false, stage: 'initialize', steps, error: normalizeErrorPayload(init.error ?? init) }, 2);
  }

  const refreshed = await client.listTools(true);
  pushStep({ stage: 'list-tools-refresh', ok: !refreshed.isErr(), error: refreshed.isErr() ? summarize(refreshed.error ?? refreshed) : undefined });
  if (refreshed.isErr()) {
    emitAndExit({ ok: false, stage: 'list-tools-refresh', steps, error: normalizeErrorPayload(refreshed.error ?? refreshed) }, 4);
  }

  proxy.ready = true;
  proxy.toolCount = refreshed.value.length;
  proxy.toolNames = refreshed.value.map((tool) => tool?.name).filter((name) => typeof name === 'string');

  emitAndExit({
    ok: true,
    stage: 'probe-complete',
    steps,
    note: 'Probe completed without opening Discord or submitting a live action.',
  }, 0);
} catch (error) {
  emitAndExit({ ok: false, stage: 'remote-exception', steps, error: normalizeErrorPayload(error) }, 20);
}
`;
}

function parseRemoteJson(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      parsed.push({ raw: sanitizeToolValue(line) });
    }
  }
  return parsed;
}

function runRemoteScript(config, envPairs, source) {
  const remoteEnv = Object.entries(envPairs)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  const remoteCommand = [
    `cd ${shellQuote(config.remoteRoot)}`,
    `${remoteEnv} ${shellQuote(config.remoteNode)} --input-type=module`,
  ].join(' && ');

  const result = spawnSync(
    'ssh',
    [
      '-i',
      config.sshKey,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      config.sshHost,
      remoteCommand,
    ],
    {
      input: source,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
  const remotePayload = parseRemotePayload(result.stdout);
  const sshOk = result.status !== 255;
  return {
    result,
    remotePayload,
    ssh: {
      ok: sshOk,
      exitStatus: result.status,
      signal: result.signal,
      stderr: sanitizeToolValue(result.stderr),
    },
  };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function copyRemoteImageCapture(config, remotePath) {
  if (!config.imageOutput || typeof remotePath !== 'string' || remotePath.trim().length === 0) {
    return undefined;
  }
  mkdirSync(dirname(config.imageOutput), { recursive: true });
  const result = spawnSync(
    'scp',
    [
      '-i',
      config.sshKey,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      `${config.sshHost}:${remotePath}`,
      config.imageOutput,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
  const ok = result.status === 0 && existsSync(config.imageOutput);
  return {
    ok,
    exitStatus: result.status,
    signal: result.signal,
    localPath: config.imageOutput,
    localPathHash: ok ? sha256File(config.imageOutput) : undefined,
    byteLength: ok ? readFileSync(config.imageOutput).length : undefined,
    stderr: sanitizeToolValue(result.stderr),
  };
}

function runRemoteControl(config) {
  const { result, remotePayload, ssh } = runRemoteScript(
    config,
    {
      MESSAGE_B64: Buffer.from(config.message, 'utf8').toString('base64'),
      DISCORD_CHANNEL_ID: config.channelId,
      DISCORD_GUILD_ID: config.guildId,
      CONTROL_MODE: config.mode,
      SLASH_COMMAND: config.slashCommand,
      COMMAND_SELECT: config.commandSelect,
      BRIDGE_PATH_B64: Buffer.from(config.bridgePath, 'utf8').toString('base64'),
      DEBUG_STEPS: config.debugSteps ? '1' : '0',
      INPUT_X: String(config.inputX),
      INPUT_Y: String(config.inputY),
      COMMAND_X: String(config.commandX),
      COMMAND_Y: String(config.commandY),
      INITIAL_WAIT_MS: String(config.initialWaitMs),
      AUTOCOMPLETE_WAIT_MS: String(config.autocompleteWaitMs),
      AFTER_SUBMIT_WAIT_MS: String(config.afterSubmitWaitMs),
      OBSERVE_MODE: config.observeMode,
      IMAGE_CAPTURE_PATH_B64: Buffer.from(config.imageCapturePath ?? '', 'utf8').toString('base64'),
      IMAGE_CAPTURE_DELAY_MS: String(config.imageCaptureDelayMs ?? 0),
    },
    buildRemoteScript(),
  );
  const control = {
    ok: result.status === 0,
    exitStatus: result.status,
    signal: result.signal,
    stdout: parseRemoteJson(result.stdout),
    stderr: sanitizeToolValue(result.stderr),
    ssh,
    submitAttempted: remotePayload?.submitAttempted === true,
    bridge: remotePayload?.bridge,
    proxy: remotePayload?.proxy,
    imageCapture: remotePayload?.imageCapture,
    error: remotePayload?.error,
  };
  if (result.status === 0 && remotePayload?.imageCapture?.ok === true) {
    control.imageCopy = copyRemoteImageCapture(config, remotePayload.imageCapture.path);
  }
  if (result.status !== 0) {
    return control;
  }
  return control;
}

function runRemoteProbe(config) {
  const { result, remotePayload, ssh } = runRemoteScript(
    config,
    {
      BRIDGE_PATH_B64: Buffer.from(config.bridgePath, 'utf8').toString('base64'),
      DEBUG_STEPS: config.debugSteps ? '1' : '0',
    },
    buildRemoteProbeScript(),
  );
  const error =
    ssh.ok === false
      ? sanitizeSshFailure(result.stderr)
      : remotePayload?.error;
  return {
    ok: result.status === 0,
    exitStatus: result.status,
    signal: result.signal,
    ssh,
    stdout: parseRemoteJson(result.stdout),
    stderr: sanitizeToolValue(result.stderr),
    remote: remotePayload,
    error,
  };
}

async function discordFetch(token, path) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { ok: response.ok, status: response.status, body };
}

function compactMessage(message) {
  return {
    id: message.id,
    authorId: message.author?.id,
    username: message.author?.username,
    bot: message.author?.bot ?? false,
    content: message.content,
    timestamp: message.timestamp,
  };
}

function resolvePollMode(args) {
  if (args.pollMode !== 'auto') {
    return args.pollMode;
  }
  if (
    args.mode === 'slash-status' ||
    args.mode === 'slash-cancel' ||
    args.mode === 'slash-focus' ||
    args.mode === 'slash-unfocus'
  ) {
    return 'command-response';
  }
  return args.mode === 'slash-ask' || args.mode === 'natural-ask'
    ? 'task-lifecycle'
    : 'marker';
}

function isAfterStart(message, startedAtMs) {
  const timestampMs = Date.parse(message.timestamp ?? '');
  return Number.isFinite(timestampMs) && timestampMs >= startedAtMs - 5000;
}

function looksLikeTaskLifecycleMessage(message) {
  return /task|accepted|running|finished|completed|failed|cancelled|queued|작업|실행|완료|실패/i.test(
    String(message.content ?? ''),
  );
}

function extractTaskId(text) {
  return String(text ?? '').match(/\bdiscord-task-[A-Za-z0-9_-]+\b/)?.[0];
}

function expectedTaskId(args) {
  return args.expectTaskId ?? extractTaskId(args.message);
}

function extractMatchSignals(message, args, startedAtMs) {
  const content = String(message.content ?? '');
  const signals = [];
  if (args.marker && content.includes(args.marker)) {
    signals.push('marker');
  }
  const taskId = extractTaskId(content);
  const expected = expectedTaskId(args);
  if (
    (expected !== undefined && taskId === expected) ||
    (expected === undefined && taskId !== undefined)
  ) {
    signals.push('task-id');
  }
  if (message.authorId) {
    signals.push('author');
  }
  if (isAfterStart(message, startedAtMs)) {
    signals.push('timing');
  }
  if (looksLikeTaskLifecycleMessage(message)) {
    signals.push('lifecycle-shape');
  }
  return [...new Set(signals)];
}

function toEvidenceObservation(message, args, startedAtMs) {
  if (!message) {
    return undefined;
  }
  const taskId = extractTaskId(message.content);
  return {
    observedAt: message.timestamp,
    source: 'discord-rest-observation',
    messageId: message.id,
    authorId: message.authorId,
    ...(taskId === undefined ? {} : { taskId }),
    ...(args.marker === undefined ? {} : { marker: args.marker }),
    matchedOn: extractMatchSignals(message, args, startedAtMs),
  };
}

function findAcknowledgementMessage(related, args, startedAtMs) {
  return (
    related.find((message) => {
      if (!message.bot) return false;
      if (args.expectAuthor && message.authorId !== args.expectAuthor) return false;
      if (!isAfterStart(message, startedAtMs)) return false;
      const content = String(message.content ?? '');
      const taskId = expectedTaskId(args);
      return (
        looksLikeTaskLifecycleMessage(message) ||
        (taskId !== undefined && content.includes(taskId)) ||
        (args.marker !== undefined && content.includes(args.marker))
      );
    }) ?? null
  );
}

/**
 * F7 — settle-shape discriminator. Task lifecycle settle events and the
 * `/status` terminal-task render both contain `Provenance:` and `Artifact:`
 * lines; `/focus` and `/unfocus` renderers (`renderFocusCreated`,
 * `renderFocusReleased`, `renderAlreadyTerminal`, `renderUnknownTask`)
 * never emit those keys. Used by `messageMatchesPollMode` to reject a
 * coincidental settle from being matched as a focus/unfocus reply.
 */
export function looksLikeTaskSettleEvent(message) {
  const content = String(message?.content ?? '');
  return /(^|\n)Provenance:\s/.test(content);
}

export function messageMatchesPollMode(message, args, pollMode, startedAtMs) {
  const content = String(message.content ?? '');
  if (!message.bot) return false;
  if (args.expectAuthor && message.authorId !== args.expectAuthor) return false;

  switch (pollMode) {
    case 'marker':
      return Boolean(args.marker) && content.includes(args.marker);
    case 'after-start':
      return isAfterStart(message, startedAtMs);
    case 'task-lifecycle':
      return (
        isAfterStart(message, startedAtMs) &&
        looksLikeTaskLifecycleMessage(message) &&
        (expectedTaskId(args) === undefined ||
          content.includes(expectedTaskId(args)))
      );
    case 'command-response': {
      const taskId = expectedTaskId(args);
      if (!isAfterStart(message, startedAtMs)) return false;
      // F7 — for slash-focus/unfocus, the legitimate command response never
      // includes `Provenance:`. Reject any settle-shaped candidate so a
      // coincidental task lifecycle settle that just happened to share the
      // same task id does not get matched as the focus/unfocus reply.
      const focusFamily =
        args.mode === 'slash-focus' || args.mode === 'slash-unfocus';
      if (focusFamily && looksLikeTaskSettleEvent(message)) return false;
      if (taskId !== undefined) return content.includes(taskId);
      if (args.marker) return content.includes(args.marker);
      return false;
    }
    default:
      return false;
  }
}

async function pollDiscordEvidence(config, botToken, startedAtMs) {
  const pollMode = resolvePollMode(config);
  let related = [];
  let acknowledgement = null;
  let matchedReply = null;
  let lastPollError = null;
  for (let i = 0; i < config.polls; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    let result;
    try {
      result = await discordFetch(botToken, `/channels/${config.channelId}/messages?limit=80`);
    } catch (error) {
      lastPollError = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (!result.ok) {
      lastPollError = `Discord message fetch failed ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`;
      continue;
    }
    lastPollError = null;
    related = result.body
      .map(compactMessage)
      .filter((message) => isAfterStart(message, startedAtMs) || (config.marker && String(message.content ?? '').includes(config.marker)));
    acknowledgement = findAcknowledgementMessage(related, config, startedAtMs);
    matchedReply = related.find((message) =>
      messageMatchesPollMode(message, config, pollMode, startedAtMs),
    ) ?? null;
    if (matchedReply) break;
  }
  return {
    pollMode,
    acknowledgement,
    ack: toEvidenceObservation(acknowledgement, config, startedAtMs),
    matchedReply,
    matchedReplyEvidence: toEvidenceObservation(matchedReply, config, startedAtMs),
    related,
    lastPollError,
  };
}

function buildConfig(args, mergedEnv) {
  const rawMessage = args.message ?? '';
  const naturalAddress =
    args.mode === 'natural-ask'
      ? resolveNaturalAskAddress(args, mergedEnv)
      : args.naturalAddress;
  return {
    ...args,
    expectTaskId: args.expectTaskId ?? extractTaskId(rawMessage),
    naturalAddress,
    message:
      args.mode === 'natural-ask'
        ? buildNaturalAskMessage(rawMessage, naturalAddress)
        : rawMessage,
    guildId: args.guildId ?? mergedEnv.AUTO_ARCHIVE_DISCORD_GUILD_ID ?? DEFAULT_GUILD_ID,
    channelId:
      args.channelId ??
      mergedEnv.AUTO_ARCHIVE_E2E_TEST_CHANNEL_ID ??
      mergedEnv.AUTO_ARCHIVE_DISCORD_CHANNEL_ID ??
      DEFAULT_CHANNEL_ID,
    sshHost: args.sshHost ?? DEFAULT_SSH_HOST,
    sshKey: args.sshKey ?? DEFAULT_SSH_KEY,
  };
}

function sanitizedConfig(config) {
  return {
    mode: config.mode,
    slashCommand: config.slashCommand,
    marker: config.marker,
    expectAuthor: config.expectAuthor,
    expectTaskId: config.expectTaskId,
    guildId: config.guildId,
    channelId: config.channelId,
    sshHost: config.sshHost,
    sshKey: config.sshKey,
    remoteRoot: config.remoteRoot,
    remoteNode: config.remoteNode,
    bridgePath: config.bridgePath,
    debugSteps: config.debugSteps,
    probe: config.probe,
    dryRun: config.dryRun,
    inputX: config.inputX,
    inputY: config.inputY,
    commandX: config.commandX,
    commandY: config.commandY,
    polls: config.polls,
    pollMs: config.pollMs,
    pollMode: resolvePollMode(config),
    commandSelect: config.commandSelect,
    observeMode: config.observeMode,
    imageCapturePath: config.imageCapturePath,
    imageOutput: config.imageOutput,
    imageCaptureDelayMs: config.imageCaptureDelayMs,
    naturalAddress: config.naturalAddress,
    mentionUserId: config.mentionUserId,
    messageLength: config.message.length,
    messagePreview: sanitizeToolValue(config.message),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const mergedEnv = {
    ...loadEnvFile(args.envFile),
    ...process.env,
  };
  const config = buildConfig(args, mergedEnv);

  if (config.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      probe: false,
      liveSubmitPerformed: false,
      config: sanitizedConfig(config),
      evidence: buildReadinessReport({
        phase: 'dry-run',
        configOk: true,
        marker: config.marker,
        expectedTaskId: config.expectTaskId,
      }).evidence,
      readiness: buildReadinessReport({
        phase: 'dry-run',
        configOk: true,
        marker: config.marker,
        expectedTaskId: config.expectTaskId,
      }),
    }, null, 2));
    return;
  }

  if (config.probe) {
    const probeResult = runRemoteProbe(config);
    const readiness = buildReadinessReport({
      phase: 'probe',
      configOk: true,
      sshOk: probeResult.ssh.ok,
      bridgePresent: probeResult.remote?.bridge?.exists,
      proxyReady: probeResult.remote?.proxy?.ready,
      probeProxyReady: probeResult.remote?.proxy?.ready,
      marker: config.marker,
      expectedTaskId: config.expectTaskId,
      error: probeResult.error,
    });
    const payload = {
      ok: readiness.submitReady && probeResult.ok,
      probe: true,
      dryRun: false,
      liveSubmitPerformed: false,
      config: sanitizedConfig(config),
      probeResult,
      evidence: readiness.evidence,
      readiness,
    };
    console.log(JSON.stringify(payload, null, 2));
    if (!payload.ok) {
      process.exit(1);
    }
    return;
  }

  const startedAtMs = Date.now();
  const control = runRemoteControl(config);
  let observation = null;
  let observationError = null;

  if (config.polls > 0) {
    const botToken = mergedEnv[config.botTokenEnv];
    if (!botToken) {
      throw new Error(`${config.botTokenEnv} missing; pass --no-rest to skip Discord REST observation`);
    }
    try {
      observation = await pollDiscordEvidence(config, botToken, startedAtMs);
    } catch (error) {
      observationError = error instanceof Error ? error.message : String(error);
    }
  }

  const ok = Boolean(control.ok && (config.polls === 0 || observation?.matchedReply));
  const readiness = buildReadinessReport({
    phase: 'live',
    configOk: true,
    sshOk: control.ssh?.ok,
    bridgePresent: control.bridge?.exists,
    proxyReady: control.proxy?.ready,
    liveProxyReady: control.proxy?.ready,
    submitAttempted: control.submitAttempted,
    controlOk: control.ok,
    restObservationAttempted: config.polls > 0,
    marker: config.marker,
    expectedTaskId: config.expectTaskId,
    ack: observation?.ack,
    matchedReply: observation?.matchedReplyEvidence,
    relatedReplyCount: observation?.related?.length ?? 0,
    matchedReplyObserved: observation?.matchedReply !== undefined && observation?.matchedReply !== null,
    error: control.error ?? (control.ssh?.ok === false ? sanitizeSshFailure(control.stderr) : observationError),
  });
  console.log(JSON.stringify({
    ok,
    startedAt: new Date(startedAtMs).toISOString(),
    marker: config.marker,
    channelId: config.channelId,
    mode: config.mode,
    control,
    observation,
    observationError,
    evidence: readiness.evidence,
    readiness,
  }, null, 2));

  if (!ok) {
    process.exit(1);
  }
}

export function isDirectControlEntrypoint(
  moduleUrl = import.meta.url,
  argv = process.argv,
) {
  return (
    argv[1] !== undefined &&
    moduleUrl === pathToFileURL(resolve(argv[1])).href
  );
}

if (isDirectControlEntrypoint()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
