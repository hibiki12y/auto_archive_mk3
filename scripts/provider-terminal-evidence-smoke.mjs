#!/usr/bin/env node
// Live provider smoke: run one runtime driver and retain redacted TerminalEvidence.
//
// This script intentionally prints only a compact safe summary. The retained
// TerminalEvidence redacts raw assistant output from transcript events while
// preserving canonical driver provenance, terminal cause, runtime settings, and
// resource envelope snapshots for `pnpm runtime:provider:evidence:report`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const USAGE = `Usage: pnpm runtime:provider:smoke -- --provider <codex|claude-agent> --out <path> [options]

Run a tiny authenticated runtime-provider smoke and write a retained
TerminalEvidence JSON artifact for the provider evidence report.

Options:
  --provider <provider>   Required provider: codex or claude-agent.
  --out <path>            Required output path for TerminalEvidence JSON.
  --task-id <id>          Optional safe task id (default: generated).
  --help                  Show this help text.

Boundary:
  Does not read .env files, does not print tokens, and does not print raw
  provider responses. The evidence transcript keeps redacted runtime telemetry
  only; the terminal reason is truncated and raw transcript item summaries are
  replaced with redaction markers.
`;

const PROVIDERS = new Set(['codex', 'claude-agent']);
const DRIVER_PROVENANCE = {
  codex: 'codex-runtime-driver',
  'claude-agent': 'claude-agent-runtime-driver',
};

function parseArgs(argv) {
  let provider;
  let out;
  let taskId;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--':
        break;
      case '--help':
      case '-h':
        return 'help';
      case '--provider':
        provider = requireValue(argv, index, '--provider');
        index += 1;
        break;
      case '--out':
        out = requireValue(argv, index, '--out');
        index += 1;
        break;
      case '--task-id':
        taskId = sanitizeTaskId(requireValue(argv, index, '--task-id'));
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg ?? '(missing)'}.`);
    }
  }

  if (provider === undefined || !PROVIDERS.has(provider)) {
    throw new Error('--provider must be codex or claude-agent.');
  }
  if (out === undefined || out.trim().length === 0) {
    throw new Error('--out is required.');
  }

  return {
    provider,
    out,
    taskId: taskId ?? `task-provider-smoke-${provider}-${Date.now()}`,
  };
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function sanitizeTaskId(value) {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(trimmed)) {
    throw new Error('--task-id must be 1-160 safe characters [A-Za-z0-9._:-].');
  }
  return trimmed;
}

async function loadRuntimeModules() {
  const [
    { createDispatchPlan },
    { createTerminalEvidence },
    { CodexRuntimeDriver },
    { resolveCodexBootstrapResolution },
    { ClaudeAgentRuntimeDriver, createDefaultClaudeAgentQueryFactory },
  ] = await Promise.all([
    import('../dist/src/core/task.js'),
    import('../dist/src/contracts/terminal-evidence.js'),
    import('../dist/src/runtime/codex-runtime-adapter.js'),
    import('../dist/src/runtime/codex-bootstrap-settings.js'),
    import('../dist/src/runtime/claude-agent-runtime-adapter.js'),
  ]);
  return {
    createDispatchPlan,
    createTerminalEvidence,
    CodexRuntimeDriver,
    resolveCodexBootstrapResolution,
    ClaudeAgentRuntimeDriver,
    createDefaultClaudeAgentQueryFactory,
  };
}

function createDriver(provider, modules) {
  if (provider === 'codex') {
    const codexEnv = {
      ...process.env,
      AUTO_ARCHIVE_CODEX_CLI_HOME_MODE:
        process.env.AUTO_ARCHIVE_CODEX_CLI_HOME_MODE ?? 'isolated-auth',
      AUTO_ARCHIVE_CODEX_ISOLATED_HOME:
        process.env.AUTO_ARCHIVE_CODEX_ISOLATED_HOME ??
        resolve('runtime-state/provider-smoke/codex-home'),
    };
    const codexResolution = modules.resolveCodexBootstrapResolution(codexEnv);
    return new modules.CodexRuntimeDriver({
      codexOptions: codexResolution.options,
      codexRuntimeConfig: codexResolution.runtimeConfig,
    });
  }

  const cliPath =
    process.env.AUTO_ARCHIVE_CLAUDE_CLI_PATH ?? '/home/deepsky/.local/bin/claude';
  const maxTurns = Number(process.env.AUTO_ARCHIVE_CLAUDE_MAX_TURNS ?? 2);
  return new modules.ClaudeAgentRuntimeDriver({
    queryFactory: modules.createDefaultClaudeAgentQueryFactory(),
    pathToClaudeCodeExecutable: cliPath,
    permissionMode: process.env.AUTO_ARCHIVE_CLAUDE_PERMISSION_MODE ?? 'bypassPermissions',
    ...(Number.isSafeInteger(maxTurns) && maxTurns > 0 ? { maxTurns } : { maxTurns: 2 }),
  });
}

function createPlan(createDispatchPlan, taskId) {
  return createDispatchPlan({
    taskId,
    instruction:
      'Reply with exactly the literal text "provider-smoke-ok" and no other text. Do not call tools.',
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: process.cwd(),
    },
    resources: {
      requested: {
        cpuCores: 1,
        memoryMiB: 256,
        wallTimeSec: 60,
        gpuCards: 0,
      },
    },
  });
}

function enrichRuntimeEvent(event, instanceId) {
  return {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
    instanceId,
  };
}

function redactReviewedItem(item, summary) {
  return {
    id:
      typeof item?.id === 'string' && item.id.length > 0
        ? item.id
        : 'redacted-provider-item',
    type: typeof item?.type === 'string' ? item.type : 'unknown',
    ...(typeof item?.originalType === 'string'
      ? { originalType: truncate(item.originalType, 120) }
      : {}),
    ...(typeof item?.status === 'string'
      ? { status: truncate(item.status, 120) }
      : {}),
    summary,
  };
}

function redactTranscriptEvent(event) {
  if (event.kind === 'turn.started' || event.kind === 'turn.completed') {
    return event;
  }
  if (event.kind === 'item.completed') {
    return {
      ...event,
      item: redactReviewedItem(event.item, '[redacted-provider-output]'),
    };
  }
  if (event.kind === 'item.failed') {
    return {
      ...event,
      item: redactReviewedItem(event.item, '[redacted-provider-item]'),
      failure: {
        message: '[redacted-provider-failure]',
        ...(event.failure?.code === undefined ? {} : { code: event.failure.code }),
      },
    };
  }
  if (event.kind === 'tool-invocation') {
    return {
      ...event,
      detail: '[redacted-provider-tool-input]',
    };
  }
  return undefined;
}

function redactTranscript(events) {
  const redacted = [];
  let droppedCount = 0;
  for (const event of events) {
    const safeEvent = redactTranscriptEvent(event);
    if (safeEvent === undefined) {
      droppedCount += 1;
    } else {
      redacted.push(safeEvent);
    }
  }
  return { events: redacted, droppedCount };
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function summarizeCause(cause) {
  if (cause.kind === 'provider-failure') {
    return {
      kind: cause.kind,
      provider: cause.provider,
      classification: cause.classification,
      retryable: cause.retryable,
    };
  }
  if (cause.kind === 'driver-failure') {
    return {
      kind: cause.kind,
      phase: cause.phase,
    };
  }
  return { kind: cause.kind };
}

function maybeProviderFailureCause(error, context) {
  const partial = error?.providerFailureCause;
  if (
    partial !== undefined &&
    typeof partial === 'object' &&
    partial.kind === 'provider-failure'
  ) {
    return {
      ...partial,
      taskId: context.plan.taskId,
      runtimeInstanceId: context.instance.instanceId,
      observedAt: new Date().toISOString(),
    };
  }
  return undefined;
}

function maybeDriverFailureCause(error) {
  const cause = error?.driverFailureCause;
  if (
    cause !== undefined &&
    typeof cause === 'object' &&
    cause.kind === 'driver-failure'
  ) {
    return cause;
  }
  return undefined;
}

function synthesizeFailureResult(error, context, provider) {
  const providerFailureCause = maybeProviderFailureCause(error, context);
  if (providerFailureCause !== undefined) {
    return {
      reason: truncate(providerFailureCause.message, 2000),
      provenance: providerFailureCause.provenance,
      artifactLocation: context.plan.artifactLocation,
      cause: providerFailureCause,
    };
  }

  const driverFailureCause = maybeDriverFailureCause(error);
  if (driverFailureCause !== undefined) {
    return {
      reason: truncate(driverFailureCause.message, 2000),
      provenance: DRIVER_PROVENANCE[provider],
      artifactLocation: context.plan.artifactLocation,
      cause: driverFailureCause,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const observedAt = new Date().toISOString();
  return {
    reason: truncate(message, 2000),
    provenance: DRIVER_PROVENANCE[provider],
    artifactLocation: context.plan.artifactLocation,
    cause: {
      kind: 'driver-failure',
      taskId: context.plan.taskId,
      runtimeInstanceId: context.instance.instanceId,
      observedAt,
      provenance: DRIVER_PROVENANCE[provider],
      phase: `${provider}.runtime-driver.run`,
      message: truncate(message, 2000),
    },
  };
}

function writeEvidence({ createTerminalEvidence, out, context, result, startedAt, endedAt, events }) {
  const transcript = redactTranscript(events);
  const evidence = createTerminalEvidence({
    taskId: context.plan.taskId,
    runtimeInstanceId: context.instance.instanceId,
    reason: truncate(result.reason, 2000),
    provenance: result.provenance,
    executionContext: {
      planCreatedAt: context.plan.createdAt,
      runtimeSettings: context.plan.runtimeSettings,
      executionStartedAt: startedAt,
    },
    resourceEnvelope: context.plan.resourceEnvelope,
    ...(result.observedSummary === undefined ? {} : { observedSummary: result.observedSummary }),
    transcript,
    startedAt,
    endedAt,
    ...(result.artifactLocation === undefined ? {} : { artifactLocation: result.artifactLocation }),
    cause: result.cause,
  });

  const outputPath = resolve(out);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return { evidence, outputPath };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const modules = await loadRuntimeModules();
  const plan = createPlan(modules.createDispatchPlan, options.taskId);
  const instance = {
    taskId: plan.taskId,
    instanceId: `agent-${plan.taskId}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    runtimeSettings: plan.runtimeSettings,
  };
  const events = [];
  const context = {
    plan,
    instance,
    emit: async (event) => {
      events.push(enrichRuntimeEvent(event, instance.instanceId));
    },
    requestApproval: async () => ({
      status: 'rejected',
      reason: 'provider smoke denies tool use',
    }),
    isAborted: () => false,
  };

  const driver = createDriver(options.provider, modules);
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await driver.run(context);
  } catch (error) {
    result = synthesizeFailureResult(error, context, options.provider);
  }
  const endedAt = new Date().toISOString();
  const { evidence, outputPath } = writeEvidence({
    createTerminalEvidence: modules.createTerminalEvidence,
    out: options.out,
    context,
    result,
    startedAt,
    endedAt,
    events,
  });

  const expectedProvenance = DRIVER_PROVENANCE[options.provider];
  const ok =
    evidence.cause.kind === 'success' &&
    (evidence.provenance === expectedProvenance || evidence.cause.provenance === expectedProvenance);

  process.stdout.write(
    `${JSON.stringify(
      {
        status: ok ? 'ok' : 'non-success',
        provider: options.provider,
        outputPath,
        provenance: evidence.provenance,
        cause: summarizeCause(evidence.cause),
        transcriptEventCount: evidence.transcript?.events.length ?? 0,
        transcriptDroppedCount: evidence.transcript?.droppedCount ?? 0,
      },
      null,
      2,
    )}\n`,
  );
  return ok ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `runtime:provider:smoke failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
  );
  process.exitCode = 1;
}
