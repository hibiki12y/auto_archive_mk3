#!/usr/bin/env node
// Smoke test: SIMULTANEOUS Arona + Plana provider hot-swap (spec v1.4.0 + 1.5.0).
//
// One shared InMemoryRuntimePersonaSettingsProvider drives BOTH:
//   - MultiProviderRuntimeDriver  (Arona dispatched-task path)
//   - MultiProviderPlanaAdvisor   (Plana review-advisor path)
//
// We mutate the shared store record so arona.provider AND plana.provider flip
// in a single apply(), then dispatch one tiny task. We assert on the same
// dispatch:
//   - The Arona sub-driver matches arona.provider (driver provenance label).
//   - The Plana advisor was consulted on the matched sub-advisor by inspecting
//     per-sub-advisor onAdvise deltas.
//
// We run four flips:
//   step 1: arona=codex,         plana=claude-agent (initial)
//   step 2: arona=claude-agent,  plana=codex        (BOTH flip)
//   step 3: arona=codex,         plana=codex        (only arona flips)
//   step 4: arona=codex,         plana=claude-agent (only plana flips)
//
// Auth: Codex via local CLI (~/.codex/auth.json), Claude via local Claude
// Code binary.

import { CodexRuntimeDriver } from '../dist/src/runtime/codex-runtime-adapter.js';
import { resolveCodexBootstrapResolution } from '../dist/src/runtime/codex-bootstrap-settings.js';
import {
  ClaudeAgentRuntimeDriver,
  createDefaultClaudeAgentQueryFactory,
} from '../dist/src/runtime/claude-agent-runtime-adapter.js';
import { MultiProviderRuntimeDriver } from '../dist/src/runtime/multi-provider-runtime-driver.js';
import { PlanaClaudeRuntimeAdvisor } from '../dist/src/core/plana-claude-runtime-advisor.js';
import { PlanaCodexRuntimeAdvisor } from '../dist/src/core/plana-codex-runtime-advisor.js';
import { MultiProviderPlanaAdvisor } from '../dist/src/core/multi-provider-plana-advisor.js';
import { Plana } from '../dist/src/core/plana.js';
import { createDispatchPlan } from '../dist/src/core/task.js';
import { createRuntimeEventStream } from '../dist/src/contracts/runtime-event-stream.js';
import { InMemoryRuntimePersonaSettingsProvider } from '../dist/src/runtime/runtime-persona-settings-provider.js';

const claudeCliPath =
  process.env.AUTO_ARCHIVE_CLAUDE_CLI_PATH ?? '/home/deepsky/.local/bin/claude';

// --- Shared settings store ----------------------------------------------------
const settingsProvider = new InMemoryRuntimePersonaSettingsProvider();

// Adapters that match each wrapper's narrow contract. Both read from the same
// underlying snapshot, so a single apply() updates everyone consistently.
const aronaProviderProvider = {
  readSettings: () => {
    const s = settingsProvider.readSettings('arona');
    return s.provider !== undefined ? { provider: s.provider } : {};
  },
};
const planaProviderProvider = {
  readSettings: () => {
    const s = settingsProvider.readSettings('plana');
    return s.provider !== undefined ? { provider: s.provider } : {};
  },
};

// --- Arona side: real codex + claude-agent drivers behind multi-provider -----
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
const aronaSelectedLog = [];
const aronaWrapper = new MultiProviderRuntimeDriver({
  codexDriver,
  claudeAgentDriver,
  defaultProvider: 'codex',
  settingsProvider: aronaProviderProvider,
  onProviderSelected: (sel) => {
    aronaSelectedLog.push({ ...sel });
    process.stderr.write(
      `[arona-selected] provider=${sel.provider} source=${sel.source}\n`,
    );
  },
});

// --- Plana side: real codex + claude advisors behind multi-provider ----------
const codexAdviseLog = [];
const planaCodexAdvisor = new PlanaCodexRuntimeAdvisor({
  codexOptions: codexResolution.options,
  maxAdvisorCallsPerInstance: 5,
  onAdvise: (info) => {
    codexAdviseLog.push({
      verdict: info.verdict.status,
      sample: info.responseText.slice(0, 80),
    });
    process.stderr.write(`[plana-codex] verdict=${info.verdict.status}\n`);
  },
});
const claudeAdviseLog = [];
const planaClaudeAdvisor = new PlanaClaudeRuntimeAdvisor({
  queryFactory: createDefaultClaudeAgentQueryFactory(),
  pathToClaudeCodeExecutable: claudeCliPath,
  maxAdvisorCallsPerInstance: 5,
  onAdvise: (info) => {
    claudeAdviseLog.push({
      verdict: info.verdict.status,
      sample: info.responseText.slice(0, 80),
    });
    process.stderr.write(`[plana-claude] verdict=${info.verdict.status}\n`);
  },
});
const planaSelectedLog = [];
const planaWrapper = new MultiProviderPlanaAdvisor({
  codexAdvisor: planaCodexAdvisor,
  claudeAdvisor: planaClaudeAdvisor,
  defaultProvider: 'claude-agent',
  settingsProvider: planaProviderProvider,
  onProviderSelected: (sel) => {
    planaSelectedLog.push({ ...sel });
    process.stderr.write(
      `[plana-selected] provider=${sel.provider} source=${sel.source}\n`,
    );
  },
});

const plana = new Plana({ runtimeAdvisor: planaWrapper });

// --- Dispatch helper ---------------------------------------------------------
function applyBoth(arona, plana) {
  settingsProvider.apply({
    schemaVersion: 1,
    arona: { provider: arona },
    plana: { provider: plana },
  });
}

async function dispatchOnce(label) {
  const plan = createDispatchPlan({
    taskId: `task-both-swap-${label}`,
    instruction:
      'Reply with exactly the literal text "both-swap-ok" (no quotes, no other text). Do not call any tools.',
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
  const instance = {
    taskId: plan.taskId,
    instanceId: `agent-${plan.taskId}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    runtimeSettings: plan.runtimeSettings,
  };

  const planaStream = createRuntimeEventStream();
  const cancellationBoundary = {
    cancel: (veto) => ({
      taskId: instance.taskId,
      reason: veto.reason,
      provenance: veto.provenance,
      requestedAt: new Date().toISOString(),
    }),
    latchRuntimeVeto: (veto) => ({
      kind: 'runtime-veto',
      taskId: instance.taskId,
      reason: veto.reason,
      provenance: veto.provenance,
      requestedAt: new Date().toISOString(),
      veto,
    }),
  };
  const planaConsumer = plana.consumeRuntimeStream(planaStream, {
    plan,
    instance,
    cancellationBoundary,
    approvalResponsePort: { async respond() {} },
  });

  const claudeBefore = claudeAdviseLog.length;
  const codexBefore = codexAdviseLog.length;

  const driverContext = {
    plan,
    instance,
    emit: async (eventInput) => {
      const fullEvent = {
        ...eventInput,
        timestamp: new Date().toISOString(),
        instanceId: instance.instanceId,
      };
      await planaStream.push(fullEvent);
    },
    requestApproval: async () => ({ status: 'approved' }),
    isAborted: () => false,
  };

  const start = Date.now();
  let result;
  try {
    result = await aronaWrapper.run(driverContext);
  } catch (error) {
    console.error(`DRIVER THREW (${label}):`, error?.name, error?.message);
    return { label, ok: false };
  }
  await planaStream.close();
  const planaReport = await planaConsumer;
  const elapsedMs = Date.now() - start;

  const claudeDelta = claudeAdviseLog.length - claudeBefore;
  const codexDelta = codexAdviseLog.length - codexBefore;

  return {
    label,
    elapsedMs,
    aronaProvenance: result.provenance,
    aronaCauseKind: result.cause.kind,
    planaEventsConsumed: planaReport.eventsConsumed,
    planaVetoes: planaReport.vetoesEmitted,
    planaClaudeDelta: claudeDelta,
    planaCodexDelta: codexDelta,
  };
}

// --- Run sequence ------------------------------------------------------------
const expectations = [
  // step, arona-target, plana-target
  { step: 'step1-codex+claude', arona: 'codex', plana: 'claude-agent' },
  { step: 'step2-claude+codex', arona: 'claude-agent', plana: 'codex' },
  { step: 'step3-codex+codex', arona: 'codex', plana: 'codex' },
  { step: 'step4-codex+claude', arona: 'codex', plana: 'claude-agent' },
];

const results = [];
for (const { step, arona, plana } of expectations) {
  applyBoth(arona, plana);
  process.stderr.write(`\n=== ${step} (arona=${arona}, plana=${plana}) ===\n`);
  const r = await dispatchOnce(step);
  results.push({ ...r, expectedArona: arona, expectedPlana: plana });
}

// --- Verdict -----------------------------------------------------------------
console.log('\n--- simultaneous arona+plana hot-swap smoke summary ---');
for (const r of results) {
  console.log(JSON.stringify(r));
}

console.log('\narona router selection log:');
console.log(JSON.stringify(aronaSelectedLog, null, 2));
console.log('\nplana router selection log:');
console.log(JSON.stringify(planaSelectedLog, null, 2));

const expectedAronaProvenance = (target) =>
  target === 'codex' ? 'codex-runtime-driver' : 'claude-agent-runtime-driver';

let allOk = true;
for (const r of results) {
  const aronaOk =
    r.aronaCauseKind === 'success' &&
    r.aronaProvenance === expectedAronaProvenance(r.expectedArona);
  // Plana sub-advisor delta: at least one consult landed on the target sub
  // (claude or codex), and zero on the other. Different runs may emit a
  // different number of advised events, but the routing must be exclusive.
  const claudeExpected = r.expectedPlana === 'claude-agent';
  const planaOk = claudeExpected
    ? r.planaClaudeDelta >= 1 && r.planaCodexDelta === 0
    : r.planaCodexDelta >= 1 && r.planaClaudeDelta === 0;
  if (!aronaOk || !planaOk) {
    allOk = false;
    console.error(
      `FAIL ${r.label}: aronaOk=${aronaOk} (got ${r.aronaProvenance}, ` +
        `cause=${r.aronaCauseKind}) planaOk=${planaOk} (claude+${r.planaClaudeDelta}/codex+${r.planaCodexDelta}, ` +
        `expected target=${r.expectedPlana})`,
    );
  }
}

const verdict = allOk ? 'OK' : 'FAIL';
console.log('VERDICT:', verdict);
process.exit(verdict === 'OK' ? 0 : 1);
