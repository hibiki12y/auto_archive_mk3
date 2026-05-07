#!/usr/bin/env node
// Deep complex-research evaluation. Significantly more demanding than the
// 11-file audit in complex-research-budget-reeval.mjs:
//
//   - Spans 4 subsystems (runtime, discord, core, contracts) and ~20+ files
//     of primary source plus test + spec cross-reference.
//   - Demands SIX structured deliverables (per-file invariant table,
//     provenance enumeration, hot-swap state machine, coverage matrix,
//     migration guide, hardening recommendations) — each scored
//     independently for presence in the final reply.
//   - Must end with the literal sentinel `deep-research-complete-OK`.
//
// We run TWO live phases with the new tunable detector knobs raised so even
// repeated cross-check tool calls (e.g., greps with the same pattern) do
// not trip the ceiling:
//
//   phase D1: Codex + full Plana stack, AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT=30
//   phase D2: Claude Agent + full Plana stack, max_turns=80, raised detector
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

const claudeCliPath =
  process.env.AUTO_ARCHIVE_CLAUDE_CLI_PATH ?? '/home/deepsky/.local/bin/claude';

const DEEP_RESEARCH_INSTRUCTION = `
End-to-end audit of the multi-provider hot-swap + tool-loop-detector
subsystem (specs v1.3.0 / v1.4.0 / v1.5.0).

Read the relevant source, tests, and spec, then produce SIX clearly
delimited deliverables in the final reply, each preceded by its exact
header line as shown:

============================================================
## Deliverable 1: per-file invariant table

For at LEAST 15 distinct files spanning runtime/, core/, and discord/,
produce one table row per file: \`file path | invariant enforced | env or
persona-setting consumed (or n/a)\`. Cover the multi-provider drivers
(both adapters and the wrapper), the persona settings store, the in-memory
+ file-backed providers, the multi-provider Plana wrapper, both Plana
sub-advisors, and the tool-loop detector.

============================================================
## Deliverable 2: veto provenance enumeration

List EVERY distinct \`provenance\` string emitted by veto paths in this
subsystem (search src/ for \`provenance:\` literals associated with
veto/cancel/runtime-veto). One bullet per provenance, with the file:line
where it is defined.

============================================================
## Deliverable 3: hot-swap state machine

Describe in 8–12 numbered steps what happens between an operator typing
\`/config set persona:arona key:provider value:claude-agent\` in Discord
and the next dispatch landing on the Claude Agent driver. Each step must
name the exact function/class involved (file:symbol form).

============================================================
## Deliverable 4: invariant ↔ test coverage matrix

For each invariant from Deliverable 1, name ONE specific test file
(tests/*.spec.ts) that exercises it, or write \`UNCOVERED\` with one
sentence reasoning if no such test exists. At least 15 rows.

============================================================
## Deliverable 5: operator migration guide v1.3.0 → v1.5.0

For an operator on v1.3.0 today who wants the full v1.5.0 surface, produce
a 5-step migration plan. Cover: env additions, runtime-state file, the
dual-auth gate, /config set semantics changes, doctor-output changes.

============================================================
## Deliverable 6: hardening recommendations

Three specific, file-anchored recommendations to harden THIS subsystem
further. Each must:
  (a) name a concrete risk you observed,
  (b) point at exact file(s) where the fix would land,
  (c) state one falsifiable acceptance test.

============================================================

Constraints:
  - READ-ONLY. Do not modify any file.
  - No web search.
  - You may grep, sed, head/tail, cat — distinct calls are encouraged for
    cross-checking; identical-fingerprint repeats up to 30x are allowed.
  - Do NOT invent file paths or invariants — anchor every claim to actual
    file contents you observed.

End with this literal sentinel on its own line:

deep-research-complete-OK
`.trim();

function buildPlan(label) {
  return createDispatchPlan({
    taskId: `task-deep-research-${label}`,
    instruction: DEEP_RESEARCH_INSTRUCTION,
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: process.cwd(),
    },
    artifactLocation: 'results/task-artifacts',
    resources: {
      requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 1800, gpuCards: 0 },
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

function scoreDeliverables(text) {
  const headers = [
    /## Deliverable 1: per-file invariant table/i,
    /## Deliverable 2: veto provenance enumeration/i,
    /## Deliverable 3: hot-swap state machine/i,
    /## Deliverable 4: invariant ?[↔↔]? ?test coverage matrix/i,
    /## Deliverable 5: operator migration guide v1\.3\.0 ?[→↔]? ?v1\.5\.0/i,
    /## Deliverable 6: hardening recommendations/i,
  ];
  const present = headers.map((re) => re.test(text));
  const sentinel = /deep-research-complete-OK/.test(text);
  return {
    deliverable1: present[0],
    deliverable2: present[1],
    deliverable3: present[2],
    deliverable4: present[3],
    deliverable5: present[4],
    deliverable6: present[5],
    deliverableScore: present.filter(Boolean).length,
    sentinelPresent: sentinel,
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
    },
  });

  const events = [];
  let toolUseCount = 0;
  let assembledText = '';
  // Concatenate ALL agent_message texts in order so the final scoring sees
  // the complete deliverable trail even when the model splits into multiple
  // assistant messages.
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
          const text =
            eventInput.item?.text ?? eventInput.item?.summary ?? '';
          if (typeof text === 'string') {
            assembledText += `${assembledText.length > 0 ? '\n' : ''}${text}`;
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
  }
  await planaStream.close();
  const planaReport = await planaConsumer;
  const elapsedMs = Date.now() - start;

  const scoring = scoreDeliverables(assembledText);
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
    detectorWarnings: warnings.length,
    detectorVetoCount: warnings.filter((w) => w.status === 'veto').length,
    finalLength: assembledText.length,
    ...scoring,
    finalPreview: assembledText.slice(0, 240),
  };
}

const phaseResults = [];

process.stderr.write(
  '\n=== Phase D1: Codex + full Plana stack, AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT=30 ===\n',
);
const codexResolution = resolveCodexBootstrapResolution(process.env);
const codexDriver = new CodexRuntimeDriver({
  codexOptions: codexResolution.options,
  codexRuntimeConfig: codexResolution.runtimeConfig,
});
phaseResults.push(
  await runViaPlana('D1-codex-deep', codexDriver, {
    [AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT]: '30',
  }),
);

process.stderr.write(
  '\n=== Phase D2: Claude Agent + full Plana stack, max_turns=80, veto=30 ===\n',
);
const claudeDriver = new ClaudeAgentRuntimeDriver({
  queryFactory: createDefaultClaudeAgentQueryFactory(),
  pathToClaudeCodeExecutable: claudeCliPath,
  permissionMode: 'bypassPermissions',
  maxTurns: 80,
});
phaseResults.push(
  await runViaPlana('D2-claude-mt80-deep', claudeDriver, {
    [AUTO_ARCHIVE_TOOL_LOOP_VETO_REPEAT_COUNT]: '30',
  }),
);

console.log('\n--- deep complex-research evaluation summary ---');
for (const r of phaseResults) {
  console.log(JSON.stringify(r));
}

const verdicts = {
  D1_success: phaseResults[0].causeKind === 'success',
  D1_min_5_of_6_deliverables: phaseResults[0].deliverableScore >= 5,
  D1_sentinel: phaseResults[0].sentinelPresent,
  D1_no_detector_veto: phaseResults[0].detectorVetoCount === 0,
  D2_success: phaseResults[1].causeKind === 'success',
  D2_min_5_of_6_deliverables: phaseResults[1].deliverableScore >= 5,
  D2_sentinel: phaseResults[1].sentinelPresent,
  D2_no_detector_veto: phaseResults[1].detectorVetoCount === 0,
};
console.log('\n--- verdicts ---');
for (const [k, v] of Object.entries(verdicts)) {
  console.log(`${v ? 'PASS' : 'FAIL'} ${k}`);
}

const ok = Object.values(verdicts).every((v) => v);
console.log('\nVERDICT:', ok ? 'OK' : 'FAIL');
process.exit(ok ? 0 : 1);
