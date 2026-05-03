#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_DISCORD_CORE_STACK_SERVICE = 'discord-service';
const DEFAULT_LOG_LINES = 160;
const DEFAULT_WAIT_MS = 0;
const DEFAULT_POLL_MS = 1000;
const REQUIRED_READY_EVENTS = Object.freeze([
  'client-ready-wait-complete',
  'command-registration-complete',
]);

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; received ${JSON.stringify(value)}`);
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

export function parseArgs(argv) {
  const args = {
    serviceName: DEFAULT_DISCORD_CORE_STACK_SERVICE,
    lines: DEFAULT_LOG_LINES,
    waitMs: DEFAULT_WAIT_MS,
    pollMs: DEFAULT_POLL_MS,
    json: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }

    const assign = (key, transform = (value) => value) => {
      const parsed = readArgValue(argv, i, arg);
      args[key] = transform(parsed.value);
      i = parsed.nextIndex;
    };

    if (arg === '--service' || arg.startsWith('--service=')) assign('serviceName');
    else if (arg === '--app' || arg.startsWith('--app=')) assign('serviceName');
    else if (arg === '--lines' || arg.startsWith('--lines=')) {
      assign('lines', (value) => parsePositiveInteger(value, '--lines'));
    } else if (arg === '--wait-ms' || arg.startsWith('--wait-ms=')) {
      assign('waitMs', (value) => parseNonNegativeInteger(value, '--wait-ms'));
    } else if (arg === '--poll-ms' || arg.startsWith('--poll-ms=')) {
      assign('pollMs', (value) => parsePositiveInteger(value, '--poll-ms'));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseComposePsJson(rawJson) {
  const text = String(rawJson ?? '').trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function findComposeService(services, serviceName) {
  return services.find(
    (service) =>
      service?.Service === serviceName ||
      service?.Name === serviceName ||
      service?.Name === `auto-archive-${serviceName}`,
  );
}

function normalizeComposeState(service, inspectState) {
  if (inspectState?.Running === true) {
    return 'running';
  }
  if (inspectState?.Running === false) {
    return inspectState.Status ?? 'stopped';
  }
  return String(service?.State ?? service?.Status ?? 'missing').toLowerCase();
}

export function parseDiscordServiceLifecycleEvents(logText) {
  const marker = 'discord-service-bot-lifecycle';
  const events = [];

  for (const line of String(logText ?? '').split(/\r?\n/)) {
    const markerIndex = line.indexOf(marker);
    if (markerIndex < 0) {
      continue;
    }
    const jsonStart = line.indexOf('{', markerIndex + marker.length);
    if (jsonStart < 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line.slice(jsonStart));
      if (typeof parsed.event === 'string') {
        events.push(parsed);
      }
    } catch {
      // Ignore non-JSON Docker log decorations around the lifecycle line.
    }
  }

  return events;
}

export function evaluateDiscordCoreStackHealth({
  serviceName = DEFAULT_DISCORD_CORE_STACK_SERVICE,
  composePsJson,
  inspectStateJson = '{}',
  containerId = '',
  logText,
  requiredEvents = REQUIRED_READY_EVENTS,
}) {
  const reasons = [];
  let services;
  let inspectState = {};

  try {
    services = parseComposePsJson(composePsJson);
  } catch (error) {
    return {
      ok: false,
      serviceName,
      state: 'unknown',
      containerId: containerId || undefined,
      requiredEvents: [...requiredEvents],
      observedEvents: [],
      missingEvents: [...requiredEvents],
      reasons: [
        error instanceof Error ? error.message : String(error),
      ],
    };
  }

  try {
    inspectState = inspectStateJson ? JSON.parse(inspectStateJson) : {};
  } catch (error) {
    reasons.push(
      `Docker inspect state is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  const service = findComposeService(services, serviceName);
  const state = normalizeComposeState(service, inspectState);
  const resolvedContainerId =
    containerId || service?.ID || service?.Name || undefined;

  if (!service) {
    reasons.push(`Docker Compose service ${serviceName} is missing.`);
  }
  if (state !== 'running') {
    reasons.push(`Docker Compose service ${serviceName} state is ${state}, not running.`);
  }
  if (!resolvedContainerId) {
    reasons.push(`Docker Compose service ${serviceName} does not expose a container id.`);
  }

  const lifecycleEvents = parseDiscordServiceLifecycleEvents(logText);
  const observedEvents = [...new Set(lifecycleEvents.map((event) => event.event))];
  const missingEvents = requiredEvents.filter(
    (event) => !observedEvents.includes(event),
  );

  if (missingEvents.length > 0) {
    reasons.push(
      `Current Docker container has not logged required Discord gateway events: ${missingEvents.join(', ')}.`,
    );
  }

  return {
    ok: reasons.length === 0,
    serviceName,
    state,
    containerId: resolvedContainerId,
    requiredEvents: [...requiredEvents],
    observedEvents,
    missingEvents,
    reasons,
  };
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function collectHealthInputs(args) {
  const composePs = runCommand('docker', [
    'compose',
    'ps',
    '--format',
    'json',
    args.serviceName,
  ]);
  const composePsQuiet = runCommand('docker', [
    'compose',
    'ps',
    '-q',
    args.serviceName,
  ]);
  const containerId = composePsQuiet.stdout.trim().split(/\r?\n/).filter(Boolean)[0] ?? '';
  const inspect = containerId
    ? runCommand('docker', ['inspect', '--format', '{{json .State}}', containerId])
    : { status: 1, stdout: '', stderr: 'container id missing' };
  let startedAt;
  try {
    startedAt = inspect.stdout ? JSON.parse(inspect.stdout).StartedAt : undefined;
  } catch {
    startedAt = undefined;
  }
  const logs = containerId
    ? runCommand('docker', [
        'logs',
        '--timestamps',
        '--tail',
        String(args.lines),
        ...(startedAt ? ['--since', startedAt] : []),
        containerId,
      ])
    : runCommand('docker', [
        'compose',
        'logs',
        '--no-color',
        '--tail',
        String(args.lines),
        args.serviceName,
      ]);

  return {
    composeStatus: composePs.status,
    composeStderr: composePs.stderr,
    inspectStatus: inspect.status,
    inspectStderr: inspect.stderr,
    logsStatus: logs.status,
    logsStderr: logs.stderr,
    composePsJson: composePs.stdout,
    inspectStateJson: inspect.stdout.trim() || '{}',
    containerId,
    logText: `${logs.stdout}\n${logs.stderr}`,
  };
}

async function waitForHealth(args) {
  const deadline = Date.now() + args.waitMs;
  let report;
  let inputs;

  do {
    inputs = collectHealthInputs(args);
    report = evaluateDiscordCoreStackHealth({
      serviceName: args.serviceName,
      composePsJson: inputs.composePsJson,
      inspectStateJson: inputs.inspectStateJson,
      containerId: inputs.containerId,
      logText: inputs.logText,
    });
    if (report.ok || Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, args.pollMs));
  } while (true);

  return {
    ...report,
    composeStatus: inputs.composeStatus,
    inspectStatus: inputs.inspectStatus,
    logsStatus: inputs.logsStatus,
    composeError: inputs.composeStderr.trim() || undefined,
    inspectError: inputs.inspectStderr.trim() || undefined,
    logsError: inputs.logsStderr.trim() || undefined,
  };
}

function printReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const status = report.ok ? 'PASS' : 'FAIL';
  console.log(
    `${status} ${report.serviceName}: state=${report.state} container=${report.containerId ?? 'n/a'} observed=${report.observedEvents.join(',') || 'none'}`,
  );
  for (const reason of report.reasons ?? []) {
    console.log(`- ${reason}`);
  }
}

function printUsage() {
  console.log(`Usage:
  node scripts/check-discord-core-stack.mjs [--service <name>] [--wait-ms <ms>] [--poll-ms <ms>] [--lines <n>] [--json]

Checks that the Docker Compose Discord core stack service is running and that
its current container logs Discord gateway readiness plus slash-command
registration.
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }

  const report = await waitForHealth(args);
  printReport(report, args.json);
  if (!report.ok) {
    process.exit(1);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
