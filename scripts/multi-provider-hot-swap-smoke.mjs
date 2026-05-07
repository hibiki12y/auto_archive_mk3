#!/usr/bin/env node
// Smoke test: live MultiProviderRuntimeDriver — operator-driven provider
// hot-swap (spec v1.4.0).
//
// Wires the real Codex driver and the real Claude Agent driver behind a
// single MultiProviderRuntimeDriver, then runs three back-to-back tiny
// dispatches with the operator override flipping between providers
// between each call:
//
//   1. no override                   → routes to defaultProvider (codex)
//   2. override = 'claude-agent'     → routes to Claude Agent driver
//   3. override = 'codex'            → routes to Codex driver again
//
// Verifies:
//   - Each dispatch lands on the expected sub-driver (provenance label).
//   - Each dispatch succeeds end-to-end against the live SDK.
//   - The wrapper consults the override fresh on every run (the same
//     wrapper instance is reused across all three calls).
//   - onProviderSelected fires once per dispatch with correct attribution.
//
// Auth: Codex via local CLI (~/.codex/auth.json), Claude via local Claude
// Code binary (single-user OAuth dev path).

import { CodexRuntimeDriver } from '../dist/src/runtime/codex-runtime-adapter.js';
import { resolveCodexBootstrapResolution } from '../dist/src/runtime/codex-bootstrap-settings.js';
import {
  ClaudeAgentRuntimeDriver,
  createDefaultClaudeAgentQueryFactory,
} from '../dist/src/runtime/claude-agent-runtime-adapter.js';
import { MultiProviderRuntimeDriver } from '../dist/src/runtime/multi-provider-runtime-driver.js';
import { createDispatchPlan } from '../dist/src/core/task.js';

const claudeCliPath =
  process.env.AUTO_ARCHIVE_CLAUDE_CLI_PATH ?? '/home/deepsky/.local/bin/claude';

const codexResolution = resolveCodexBootstrapResolution(process.env);
const codexDriver = new CodexRuntimeDriver({
  codexOptions: codexResolution.options,
  codexRuntimeConfig: codexResolution.runtimeConfig,
});

const claudeAgentDriver = new ClaudeAgentRuntimeDriver({
  queryFactory: createDefaultClaudeAgentQueryFactory(),
  pathToClaudeCodeExecutable: claudeCliPath,
  permissionMode: 'bypassPermissions',
  maxTurns: 2,
});

let activeOverride;
const auditLog = [];

const wrapper = new MultiProviderRuntimeDriver({
  codexDriver,
  claudeAgentDriver,
  defaultProvider: 'codex',
  settingsProvider: {
    readSettings: () =>
      activeOverride === undefined ? {} : { provider: activeOverride },
  },
  onProviderSelected: (sel) => {
    auditLog.push({ ...sel });
    process.stderr.write(
      `[selected] provider=${sel.provider} source=${sel.source}\n`,
    );
  },
});

function buildContext(label) {
  const events = [];
  const plan = createDispatchPlan({
    taskId: `task-mp-swap-${label}`,
    instruction:
      'Reply with exactly the literal text "mp-swap-ok" (no quotes, no other text). Do not call any tools.',
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: process.cwd(),
    },
    artifactLocation: 'results/task-artifacts',
    resources: {
      requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
    },
  });
  const context = {
    plan,
    instance: {
      taskId: plan.taskId,
      instanceId: `agent-${plan.taskId}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      runtimeSettings: plan.runtimeSettings,
    },
    emit: async (event) => {
      events.push(event);
    },
    requestApproval: async () => ({
      status: 'rejected',
      reason: 'smoke test denies tools',
    }),
    isAborted: () => false,
  };
  return { context, events };
}

async function dispatch(label, expectedProvenance) {
  const { context, events } = buildContext(label);
  const start = Date.now();
  let result;
  try {
    result = await wrapper.run(context);
  } catch (error) {
    console.error(`DRIVER THREW (${label}):`, error?.name, error?.message);
    return { label, ok: false };
  }
  const elapsedMs = Date.now() - start;
  const provenanceMatched = result.provenance === expectedProvenance;
  const success = result.cause.kind === 'success';
  const ok = provenanceMatched && success;
  process.stderr.write(
    `[dispatch ${label}] elapsedMs=${elapsedMs} provenance=${result.provenance} ` +
      `cause=${result.cause.kind} events=${events.length}\n`,
  );
  return {
    label,
    ok,
    elapsedMs,
    provenance: result.provenance,
    causeKind: result.cause.kind,
    eventCount: events.length,
  };
}

const results = [];

activeOverride = undefined;
results.push(await dispatch('default-codex', 'codex-runtime-driver'));

activeOverride = 'claude-agent';
results.push(
  await dispatch('override-claude-agent', 'claude-agent-runtime-driver'),
);

activeOverride = 'codex';
results.push(await dispatch('override-codex', 'codex-runtime-driver'));

console.log('\n--- multi-provider hot-swap smoke summary ---');
for (const r of results) {
  console.log(JSON.stringify(r));
}
console.log('audit log:');
console.log(JSON.stringify(auditLog, null, 2));

const allOk = results.every((r) => r.ok);
const auditMatches =
  auditLog.length === 3 &&
  auditLog[0].provider === 'codex' &&
  auditLog[0].source === 'default' &&
  auditLog[1].provider === 'claude-agent' &&
  auditLog[1].source === 'override' &&
  auditLog[2].provider === 'codex' &&
  auditLog[2].source === 'override';

const verdict = allOk && auditMatches ? 'OK' : 'FAIL';
console.log('VERDICT:', verdict);
process.exit(verdict === 'OK' ? 0 : 1);
