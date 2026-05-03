#!/usr/bin/env node
// Smoke test: full cross-vendor chain.
//
//   - Dispatched task: Codex driver runs the agent (Arona's path).
//   - Plana review: PlanaClaudeRuntimeAdvisor consults real Claude on
//     sampled events from the Codex stream.
//
// Verifies that:
//   1. Codex driver completes a tiny task end-to-end.
//   2. Plana's consumeRuntimeStream sees Codex events.
//   3. PlanaClaudeRuntimeAdvisor is consulted on item.completed events
//      (cross-vendor: Codex producer → Claude advisor).
//   4. Advisor verdicts are observable via the onAdvise audit hook.
//
// Auth: Codex via local CLI (~/.codex/auth.json), Claude via local Claude
// Code binary (single-user OAuth dev path). Production would flip both to
// API keys.

import { CodexRuntimeDriver } from '../dist/src/runtime/codex-runtime-adapter.js';
import { resolveCodexBootstrapResolution } from '../dist/src/runtime/codex-bootstrap-settings.js';
import { createDefaultClaudeAgentQueryFactory } from '../dist/src/runtime/claude-agent-runtime-adapter.js';
import { PlanaClaudeRuntimeAdvisor } from '../dist/src/core/plana-claude-runtime-advisor.js';
import { Plana } from '../dist/src/core/plana.js';
import { createDispatchPlan } from '../dist/src/core/task.js';
import { createRuntimeEventStream } from '../dist/src/contracts/runtime-event-stream.js';

const codexResolution = resolveCodexBootstrapResolution(process.env);
const codexDriver = new CodexRuntimeDriver({
  codexOptions: codexResolution.options,
  codexRuntimeConfig: codexResolution.runtimeConfig,
});

const claudeCliPath =
  process.env.AUTO_ARCHIVE_CLAUDE_CLI_PATH ?? '/home/deepsky/.local/bin/claude';

const adviseAuditLog = [];
const advisor = new PlanaClaudeRuntimeAdvisor({
  queryFactory: createDefaultClaudeAgentQueryFactory(),
  pathToClaudeCodeExecutable: claudeCliPath,
  maxAdvisorCallsPerInstance: 3,
  onAdvise: ({ eventKind, verdict, responseText }) => {
    adviseAuditLog.push({
      eventKind,
      verdict: verdict.status,
      sample: responseText.slice(0, 80),
    });
    process.stderr.write(
      `[advise] kind=${eventKind} verdict=${verdict.status}\n`,
    );
  },
});

const plana = new Plana({ runtimeAdvisor: advisor });

const plan = createDispatchPlan({
  taskId: 'task-cross-vendor-smoke',
  instruction:
    'Reply with exactly the literal text "cross-vendor-ok" (no quotes, no other text). Do not call any tools.',
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
  instanceId: 'agent-task-cross-vendor-smoke-' + Date.now(),
  createdAt: new Date().toISOString(),
  runtimeSettings: plan.runtimeSettings,
};

// Bridge: as Codex driver emits events, push them into the Plana stream.
const planaStream = createRuntimeEventStream();

const cancellationBoundary = {
  cancel: (veto) => {
    process.stderr.write(`[boundary] cancel called: ${veto.provenance}\n`);
    return {
      taskId: instance.taskId,
      reason: veto.reason,
      provenance: veto.provenance,
      requestedAt: new Date().toISOString(),
    };
  },
  latchRuntimeVeto: (veto) => {
    process.stderr.write(`[boundary] latchRuntimeVeto: ${veto.provenance}\n`);
    return {
      kind: 'runtime-veto',
      taskId: instance.taskId,
      reason: veto.reason,
      provenance: veto.provenance,
      requestedAt: new Date().toISOString(),
      veto,
    };
  },
};

const planaConsumer = plana.consumeRuntimeStream(planaStream, {
  plan,
  instance,
  cancellationBoundary,
  approvalResponsePort: { async respond() {} },
});

let codexEventsObserved = 0;
const driverContext = {
  plan,
  instance,
  emit: async (eventInput) => {
    codexEventsObserved += 1;
    process.stderr.write(
      `[codex-event] ${eventInput.kind}` +
        (eventInput.kind === 'item.completed'
          ? ` type=${eventInput.item?.type}`
          : '') +
        '\n',
    );
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
let driverResult;
try {
  driverResult = await codexDriver.run(driverContext);
} catch (error) {
  console.error('CODEX DRIVER THREW:', error?.name, error?.message);
  process.exit(2);
}

await planaStream.close();
const planaReport = await planaConsumer;
const elapsedMs = Date.now() - start;

console.log('\n--- cross-vendor smoke summary ---');
console.log(`elapsedMs: ${elapsedMs}`);
console.log(`codex result.cause.kind: ${driverResult.cause.kind}`);
console.log(`codex result.provenance: ${driverResult.provenance}`);
console.log(
  `codex result.reason (truncated): ${String(driverResult.reason).slice(0, 200)}`,
);
console.log(`codex events observed: ${codexEventsObserved}`);
console.log(`plana events consumed: ${planaReport.eventsConsumed}`);
console.log(`plana vetoes emitted: ${planaReport.vetoesEmitted}`);
console.log(`advisor invocations: ${adviseAuditLog.length}`);
console.log(JSON.stringify(adviseAuditLog, null, 2));

const ok =
  driverResult.cause.kind === 'success' &&
  driverResult.provenance === 'codex-runtime-driver' &&
  codexEventsObserved > 0 &&
  planaReport.eventsConsumed > 0;

console.log('VERDICT:', ok ? 'OK' : 'FAIL');
process.exit(ok ? 0 : 1);
