#!/usr/bin/env node
// Live re-evaluation: complex-research feasibility under longer budgets,
// AFTER the env-driven tool-loop-detector knobs landed.
//
// This script replaces the earlier turn-budget-eval.mjs which bypassed Plana
// entirely (just `driver.run(context)`). Here we route every event through
// `Plana.consumeRuntimeStream(...)` so the loop detector is actually in the
// path — the real production shape.
//
// Three live phases:
//
//   phase A: Codex through full Plana stack, deeply complex 11-file audit.
//            Default detector. Hypothesis: distinct-fingerprint calls do NOT
//            trip the ceiling regardless of count.
//
//   phase B: Claude Agent through full Plana stack, same task, max_turns=40.
//            Hypothesis: longer budget unlocks the same complex audit.
//
//   phase C: Synthetic same-fingerprint stream injected directly into a Plana
//            consumer. Sub-phase C1 default detector → expect veto + abort.
//            Sub-phase C2 AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT=20 → expect
//            no veto for 19 repeats.
//
// Auth: Codex via local CLI, Claude via local Claude Code binary.

import { CodexRuntimeDriver } from '../dist/src/runtime/codex-runtime-adapter.js';
import { resolveCodexBootstrapResolution } from '../dist/src/runtime/codex-bootstrap-settings.js';
import {
  ClaudeAgentRuntimeDriver,
  createDefaultClaudeAgentQueryFactory,
} from '../dist/src/runtime/claude-agent-runtime-adapter.js';
import { Plana } from '../dist/src/core/plana.js';
import { createDispatchPlan } from '../dist/src/core/task.js';
import { createRuntimeEventStream } from '../dist/src/contracts/runtime-event-stream.js';
import {
  AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT,
  resolveToolLoopDetectorConfigFromEnv,
} from '../dist/src/core/tool-loop-detector.js';
import { createRuntimeEvent } from '../dist/src/index.js';

const claudeCliPath =
  process.env.AUTO_ARCHIVE_CLAUDE_CLI_PATH ?? '/home/deepsky/.local/bin/claude';

const COMPLEX_RESEARCH_INSTRUCTION = `
Audit the v1.3.0 / v1.4.0 / v1.5.0 dispatch-boundary persona hot-swap chain.

For EACH of these files, report ONE concrete invariant the file enforces and
ONE env var or persona setting it consumes (one short bullet per file):

  - src/runtime/multi-provider-runtime-driver.ts
  - src/runtime/runtime-persona-settings-provider.ts
  - src/runtime/runtime-driver-factory.ts
  - src/runtime/codex-runtime-adapter.ts
  - src/runtime/claude-agent-runtime-adapter.ts
  - src/discord/persona-settings-store.ts
  - src/core/multi-provider-plana-advisor.ts
  - src/core/plana-codex-runtime-advisor.ts
  - src/core/tool-loop-detector.ts

Then produce:
  1. A 5-bullet summary of how a single \`/config set persona:arona key:provider value:claude-agent\` flows from Discord input to runtime behavior.
  2. A 3-bullet summary of how Plana provider hot-swap (v1.5.0) differs from Arona's (v1.4.0).
  3. A 2-bullet observation about the new tool-loop detector env knobs.

Do NOT modify any files. Read-only research. End with the literal sentinel
line:

research-complete-OK
`.trim();

function buildPlan(label) {
  return createDispatchPlan({
    taskId: `task-complex-reeval-${label}`,
    instruction: COMPLEX_RESEARCH_INSTRUCTION,
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: process.cwd(),
    },
    artifactLocation: 'results/task-artifacts',
    resources: {
      requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 1200, gpuCards: 0 },
    },
  });
}

function buildBoundary(taskId) {
  return {
    cancel: (veto) => ({
      taskId,
      reason: veto.reason,
      provenance: veto.provenance,
      requestedAt: new Date().toISOString(),
    }),
    latchRuntimeVeto: (veto) => ({
      kind: 'runtime-veto',
      taskId,
      reason: veto.reason,
      provenance: veto.provenance,
      requestedAt: new Date().toISOString(),
      veto,
    }),
  };
}

async function runViaPlana(label, driver, env) {
  const plan = buildPlan(label);
  const instance = {
    taskId: plan.taskId,
    instanceId: `agent-${plan.taskId}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    runtimeSettings: plan.runtimeSettings,
  };
  const planaStream = createRuntimeEventStream();
  const detectorConfig = resolveToolLoopDetectorConfigFromEnv(env);
  const plana = new Plana({
    ...(detectorConfig.detector === undefined
      ? {}
      : { toolLoopDetector: detectorConfig.detector }),
  });
  const warnings = [];
  const planaConsumer = plana.consumeRuntimeStream(planaStream, {
    plan,
    instance,
    cancellationBoundary: buildBoundary(plan.taskId),
    approvalResponsePort: { async respond() {} },
    onRuntimeWarning: (warning) => {
      warnings.push({
        kind: warning.kind,
        status: warning.status,
        count: warning.count,
        provenance: warning.provenance,
      });
      process.stderr.write(
        `[${label}/plana-warn] ${warning.status}@${warning.count} ${warning.provenance}\n`,
      );
    },
  });

  const events = [];
  let toolUseCount = 0;
  let finalText = '';
  const driverContext = {
    plan,
    instance,
    emit: async (eventInput) => {
      events.push(eventInput);
      const fullEvent = {
        ...eventInput,
        timestamp: new Date().toISOString(),
        instanceId: instance.instanceId,
      };
      if (eventInput.kind === 'item.completed') {
        const t = eventInput.item?.type;
        if (
          t === 'command_execution' ||
          t === 'file_change' ||
          t === 'mcp_tool_call' ||
          t === 'web_search'
        ) {
          toolUseCount++;
        }
        if (t === 'agent_message') {
          const text = eventInput.item?.summary ?? eventInput.item?.text ?? '';
          if (typeof text === 'string' && text.length > finalText.length) {
            finalText = text;
          }
        }
      }
      await planaStream.push(fullEvent);
    },
    requestApproval: async () => ({ status: 'approved' }),
    isAborted: () => false,
  };

  const start = Date.now();
  let driverResult;
  let driverThrew;
  try {
    driverResult = await driver.run(driverContext);
  } catch (error) {
    driverThrew = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
    process.stderr.write(`[${label}/driver-threw] ${driverThrew}\n`);
  }
  await planaStream.close();
  const planaReport = await planaConsumer;
  const elapsedMs = Date.now() - start;

  const sentinel = /research-complete-OK/.test(finalText);
  return {
    label,
    causeKind: driverResult?.cause?.kind ?? 'driver-threw',
    provenance: driverResult?.provenance,
    driverThrew,
    elapsedMs,
    eventCount: events.length,
    toolUseCount,
    planaEventsConsumed: planaReport.eventsConsumed,
    planaVetoes: planaReport.vetoesEmitted,
    planaTerminalCause: planaReport.terminalCause,
    detectorWarnings: warnings.length,
    detectorVetoCount: warnings.filter((w) => w.status === 'veto').length,
    finalLength: finalText.length,
    sentinelPresent: sentinel,
    finalPreview: finalText.slice(0, 200),
  };
}

async function runSyntheticPhase(label, env, repetitions) {
  const planaStream = createRuntimeEventStream();
  const detectorConfig = resolveToolLoopDetectorConfigFromEnv(env);
  const plana = new Plana({
    ...(detectorConfig.detector === undefined
      ? {}
      : { toolLoopDetector: detectorConfig.detector }),
  });
  const plan = buildPlan(label);
  const instance = {
    taskId: plan.taskId,
    instanceId: `agent-${plan.taskId}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    runtimeSettings: plan.runtimeSettings,
  };
  const warnings = [];
  const consumer = plana.consumeRuntimeStream(planaStream, {
    plan,
    instance,
    cancellationBoundary: buildBoundary(plan.taskId),
    approvalResponsePort: { async respond() {} },
    onRuntimeWarning: (warning) => warnings.push({
      kind: warning.kind,
      status: warning.status,
      count: warning.count,
    }),
  });

  // Replay N identical-fingerprint synthetic events through the stream.
  for (let i = 0; i < repetitions; i++) {
    await planaStream.push(
      createRuntimeEvent({
        kind: 'tool-invocation',
        instanceId: instance.instanceId,
        toolName: 'shell',
        toolKind: 'shell',
        detail: `shell repeated`,
        argumentsDigest: 'identical-digest',
        observedDeltaDigest: 'same-delta',
      }),
    );
  }
  await planaStream.close();
  const report = await consumer;

  return {
    label,
    repetitions,
    detectorMode: detectorConfig.detector === false ? 'disabled'
      : detectorConfig.detector === undefined ? 'default'
      : 'configured',
    resolvedOptions: detectorConfig.resolvedOptions,
    planaVetoes: report.vetoesEmitted,
    planaTerminalCause: report.terminalCause,
    eventsConsumed: report.eventsConsumed,
    detectorWarnings: warnings.filter((w) => w.status === 'warn').length,
    detectorVetoCount: warnings.filter((w) => w.status === 'veto').length,
  };
}

const phaseResults = [];

// --- Phase A: Codex through full Plana stack ---------------------------------
process.stderr.write('\n=== Phase A: Codex + full Plana stack, default detector ===\n');
const codexResolution = resolveCodexBootstrapResolution(process.env);
const codexDriver = new CodexRuntimeDriver({
  codexOptions: codexResolution.options,
  codexRuntimeConfig: codexResolution.runtimeConfig,
});
phaseResults.push(await runViaPlana('A-codex', codexDriver, {}));

// --- Phase B: Claude Agent at high max_turns through full Plana stack --------
process.stderr.write('\n=== Phase B: Claude Agent + full Plana stack, max_turns=40 ===\n');
const claudeDriver = new ClaudeAgentRuntimeDriver({
  queryFactory: createDefaultClaudeAgentQueryFactory(),
  pathToClaudeCodeExecutable: claudeCliPath,
  permissionMode: 'bypassPermissions',
  maxTurns: 40,
});
phaseResults.push(await runViaPlana('B-claude-mt40', claudeDriver, {}));

// --- Phase C1: synthetic same-fingerprint replay, default detector -----------
process.stderr.write('\n=== Phase C1: synthetic 8x same-fingerprint, default detector ===\n');
phaseResults.push(await runSyntheticPhase('C1-default-8reps', {}, 8));

// --- Phase C2: synthetic same-fingerprint replay, raised threshold -----------
process.stderr.write('\n=== Phase C2: synthetic 19x same-fingerprint, raised veto=20 ===\n');
phaseResults.push(
  await runSyntheticPhase(
    'C2-raised-19reps',
    { [AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT]: '20' },
    19,
  ),
);

// --- Report ------------------------------------------------------------------
console.log('\n--- complex-research budget re-evaluation summary ---');
for (const r of phaseResults) {
  console.log(JSON.stringify(r));
}

const phaseA = phaseResults[0];
const phaseB = phaseResults[1];
const phaseC1 = phaseResults[2];
const phaseC2 = phaseResults[3];

const verdicts = {
  // Phase A: complex distinct-call research must complete with no veto.
  'A-codex-success': phaseA.causeKind === 'success',
  'A-codex-no-detector-veto': phaseA.detectorVetoCount === 0,
  // Phase B: longer-budget Claude must also complete.
  'B-claude-mt40-success': phaseB.causeKind === 'success',
  'B-claude-mt40-no-detector-veto': phaseB.detectorVetoCount === 0,
  // Phase C1: default detector MUST veto the synthetic loop at 6 reps.
  'C1-default-vetoes': phaseC1.detectorVetoCount >= 1,
  // Phase C2: raised threshold MUST allow 19 reps with no veto.
  'C2-raised-no-veto': phaseC2.detectorVetoCount === 0,
};

console.log('\n--- verdicts ---');
for (const [k, v] of Object.entries(verdicts)) {
  console.log(`${v ? 'PASS' : 'FAIL'} ${k}`);
}
const ok = Object.values(verdicts).every((v) => v);
console.log('\nVERDICT:', ok ? 'OK' : 'FAIL');
process.exit(ok ? 0 : 1);
