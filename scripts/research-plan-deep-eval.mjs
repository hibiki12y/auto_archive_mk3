#!/usr/bin/env node
// Decomposed deep-research live eval.
//
// Re-runs the same 6-deliverable mega-audit that defeated single-shot in
// scripts/deep-research-eval.mjs (D1: Codex 502 at ~17 min; D2: Claude
// max_turns=80 budget exhaustion). Now decomposed by runResearchPlan(...) into
// 6 sub-tasks (one per deliverable) plus a 7th synthesis dispatch.
//
// Provider: Codex (the worse performer in the single-shot failure).
//
// Each sub-task is intentionally narrow (~3-5 file reads + one short bullet
// list). The synthesis dispatch receives the joined sub-task outputs and is
// asked to produce the final aggregated report ending with the sentinel
// `deep-research-decomposed-OK`.
//
// Auth: Codex via local CLI (~/.codex/auth.json).

import { CodexRuntimeDriver } from '../dist/src/runtime/codex-runtime-adapter.js';
import { resolveCodexBootstrapResolution } from '../dist/src/runtime/codex-bootstrap-settings.js';
import {
  RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN,
  runResearchPlan,
} from '../dist/src/core/research-plan-orchestrator.js';

const codexResolution = resolveCodexBootstrapResolution(process.env);
const driver = new CodexRuntimeDriver({
  codexOptions: codexResolution.options,
  codexRuntimeConfig: codexResolution.runtimeConfig,
});

const RUNTIME_SETTINGS = {
  networkProfile: 'provider-only',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
  workingDirectory: process.cwd(),
};

const RESOURCES = {
  requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 600, gpuCards: 0 },
};

const PLAN = {
  runtimeSettings: RUNTIME_SETTINGS,
  resources: RESOURCES,
  subTasks: [
    {
      taskId: 'task-deliverable-1-invariant-table',
      instruction: `
Read the following files (READ-ONLY) and produce ONE table row per file in
the form \`file path | invariant enforced | env or persona-setting consumed\`:

  - src/runtime/multi-provider-runtime-driver.ts
  - src/runtime/runtime-persona-settings-provider.ts
  - src/runtime/codex-runtime-adapter.ts
  - src/runtime/claude-agent-runtime-adapter.ts
  - src/discord/persona-settings-store.ts
  - src/core/multi-provider-plana-advisor.ts
  - src/core/plana-codex-runtime-advisor.ts
  - src/core/plana-claude-runtime-advisor.ts
  - src/core/tool-loop-detector.ts

Output a markdown table titled \`## Deliverable 1: per-file invariant table\`
with exactly those file paths in that order.
      `.trim(),
    },
    {
      taskId: 'task-deliverable-2-veto-provenance',
      instruction: `
Search src/ for distinct \`provenance:\` literals attached to veto / runtime-
veto / cancellation paths in the multi-provider + plana subsystem. List each
under a header \`## Deliverable 2: veto provenance enumeration\`. One bullet
per provenance with file:line. Include at minimum:
  - \`codex-runtime-driver\`
  - \`claude-agent-runtime-driver\`
  - \`plana-claude-runtime-advisor\`
  - \`plana-codex-runtime-advisor\`
  - \`plana-tool-loop-detector\`
You may add others you find; do not invent any.
      `.trim(),
    },
    {
      taskId: 'task-deliverable-3-state-machine',
      instruction: `
Trace the full path between an operator typing
\`/config set persona:arona key:provider value:claude-agent\` in Discord and
the next dispatch landing on the Claude Agent driver. Output 8-12 numbered
steps under \`## Deliverable 3: hot-swap state machine\`. Each step must name
the exact file:symbol involved (e.g.,
\`src/discord/discord-command-handlers.ts:handleConfig\`). Cover:
discord-command-handlers, persona-settings-store, runtime-persona-settings-
provider (in-memory apply), multi-provider-runtime-driver
(resolveActiveProvider), and the chosen sub-driver's run().
      `.trim(),
    },
    {
      taskId: 'task-deliverable-4-coverage-matrix',
      instruction: `
For each of these invariants, name ONE \`tests/*.spec.ts\` file that exercises
it, or write \`UNCOVERED + 1-line reason\` if absent. Output under
\`## Deliverable 4: invariant ↔ test coverage matrix\`:

  - MultiProviderRuntimeDriver routes per-call by override / falls back to default
  - MultiProviderPlanaAdvisor routes per-call by override / falls back to default
  - PlanaCodexRuntimeAdvisor fails open on SDK throw
  - PlanaCodexRuntimeAdvisor enforces per-instance call cap
  - persona-settings-store coerces and validates value types
  - runtime-persona-settings-provider applies record snapshot wholesale
  - tool-loop-detector env knobs honor raised veto and reject warn>=veto

Use exact spec file names found via \`ls tests/ | grep\`.
      `.trim(),
    },
    {
      taskId: 'task-deliverable-5-migration-guide',
      instruction: `
For an operator on v1.3.0 who wants the full v1.5.0 surface, produce a 5-step
migration plan under \`## Deliverable 5: operator migration guide v1.3.0 →
v1.5.0\`. Address: env additions (.env.example), the runtime-state file
(runtime-state/persona-settings.json), the dual-auth gate, /config set
provider semantics, doctor-output changes. Anchor every recommendation to a
specific file path you actually read.
      `.trim(),
    },
    {
      taskId: 'task-deliverable-6-hardening',
      instruction: `
Three specific, file-anchored recommendations to harden the multi-provider +
plana hot-swap subsystem further. Each must (a) name a concrete risk
observed in the source, (b) point at exact file(s), (c) state one falsifiable
acceptance test. Output under \`## Deliverable 6: hardening recommendations\`.
      `.trim(),
    },
  ],
  synthesis: {
    taskId: 'task-deep-synthesis',
    instructionTemplate: `
You are aggregating the outputs of six separate research sub-tasks into a
single final report on the auto_archive_mk3 multi-provider + Plana hot-swap
subsystem. Each sub-task produced its own deliverable with its own header.

Below are the six sub-task outputs. Compose the final report by including
ALL six deliverable sections in order (1 through 6). DO NOT paraphrase —
reproduce each section's substance verbatim where it is non-trivial. You may
fix obvious markdown rendering issues (e.g., trailing whitespace, missing
table separators).

After the six sections, add an overall 3-bullet executive summary under
\`## Executive Summary\`.

End with this literal sentinel on its own line:

deep-research-decomposed-OK

--- Sub-task outputs ---

${RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN}
    `.trim(),
  },
};

const start = Date.now();
let lastEventLog = start;
const result = await runResearchPlan(driver, PLAN, {
  onEvent: ({ subTaskId, event }) => {
    const now = Date.now();
    // Log a heartbeat every ~5s plus all major lifecycle markers.
    if (
      event.kind === 'turn.started' ||
      event.kind === 'turn.completed' ||
      now - lastEventLog > 5000
    ) {
      process.stderr.write(
        `[${subTaskId}] ${event.kind} @+${(now - start) / 1000}s\n`,
      );
      lastEventLog = now;
    }
  },
});
const elapsed = Date.now() - start;

console.log('\n--- decomposed deep-research evaluation summary ---');
for (const o of result.subTaskOutcomes) {
  console.log(
    JSON.stringify({
      subTaskId: o.subTaskId,
      causeKind: o.causeKind,
      elapsedMs: o.elapsedMs,
      eventCount: o.eventCount,
      toolUseCount: o.toolUseCount,
      finalLength: o.finalText.length,
      finalPreview: o.finalText.slice(0, 100),
    }),
  );
}
if (result.synthesisOutcome !== undefined) {
  console.log(
    JSON.stringify({
      subTaskId: result.synthesisOutcome.subTaskId,
      causeKind: result.synthesisOutcome.causeKind,
      elapsedMs: result.synthesisOutcome.elapsedMs,
      eventCount: result.synthesisOutcome.eventCount,
      toolUseCount: result.synthesisOutcome.toolUseCount,
      finalLength: result.synthesisOutcome.finalText.length,
      finalPreview: result.synthesisOutcome.finalText.slice(0, 200),
    }),
  );
}
console.log(`\ntotal elapsed: ${(elapsed / 1000).toFixed(1)}s`);
console.log(`stoppedEarly: ${result.stoppedEarly}`);

const headers = [
  /## Deliverable 1: per-file invariant table/i,
  /## Deliverable 2: veto provenance enumeration/i,
  /## Deliverable 3: hot-swap state machine/i,
  /## Deliverable 4: invariant ?[↔↔]? ?test coverage matrix/i,
  /## Deliverable 5: operator migration guide/i,
  /## Deliverable 6: hardening recommendations/i,
];
const aggregated = result.aggregatedReport;
const present = headers.map((re) => re.test(aggregated));
const sentinel = /deep-research-decomposed-OK/.test(aggregated);
const score = present.filter(Boolean).length;

console.log('\n--- deliverable scoring (in synthesis output) ---');
present.forEach((p, i) => {
  console.log(`${p ? 'PASS' : 'FAIL'} Deliverable ${i + 1}`);
});
console.log(`Sentinel present: ${sentinel}`);
console.log(`Deliverable score: ${score}/6`);

const allSubsSucceeded = result.subTaskOutcomes.every((o) => o.causeKind === 'success');
const synthesisSucceeded = result.synthesisOutcome?.causeKind === 'success';
const verdict =
  allSubsSucceeded && synthesisSucceeded && score >= 5 && sentinel ? 'OK' : 'FAIL';
console.log('\nVERDICT:', verdict);
process.exit(verdict === 'OK' ? 0 : 1);
