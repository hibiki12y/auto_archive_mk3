#!/usr/bin/env node
// Turn-budget evaluation harness.
//
// Runs the SAME moderately-complex research task at progressively higher
// max_turns budgets (Claude Agent path) and at a default-budget Codex run for
// comparison. Reports per-run:
//
//   - cause.kind                        (success / error-cause label)
//   - elapsedMs                         (wall-clock dispatch time)
//   - emit count + emit kinds histogram (driver activity)
//   - tool_use count                    (research-shape proxy)
//   - turn count                        (Claude SDK only — counted from result)
//   - finalText length / preview        (output substance)
//
// Decisions to make from the trace:
//   - Does increasing max_turns unlock more research depth (higher tool_use,
//     longer final, more turns)?
//   - Does the run abort early (max_turns hit, loop-detector veto, provider
//     failure), or complete naturally?
//   - Is Codex bound by a different ceiling (loop detector, no max_turns)?
//
// Auth: Codex via local CLI, Claude via local Claude Code binary.

import {
  ClaudeAgentRuntimeDriver,
  createDefaultClaudeAgentQueryFactory,
} from '../dist/src/runtime/claude-agent-runtime-adapter.js';
import { CodexRuntimeDriver } from '../dist/src/runtime/codex-runtime-adapter.js';
import { resolveCodexBootstrapResolution } from '../dist/src/runtime/codex-bootstrap-settings.js';
import { createDispatchPlan } from '../dist/src/core/task.js';

const claudeCliPath =
  process.env.AUTO_ARCHIVE_CLAUDE_CLI_PATH ?? '/home/deepsky/.local/bin/claude';

// Moderately complex research task — needs distinct file reads (so loop
// detector should NOT trip on identical-fingerprint repeats) plus a
// synthesis turn.
const RESEARCH_INSTRUCTION = `
You are auditing a multi-provider runtime layer. Read the following files in
order and then produce a 5-bullet summary of how they cooperate to dispatch
one task to one of two backends:

  - src/runtime/multi-provider-runtime-driver.ts
  - src/runtime/claude-agent-runtime-adapter.ts
  - src/runtime/codex-runtime-adapter.ts
  - src/runtime/runtime-persona-settings-provider.ts
  - src/runtime/runtime-driver-factory.ts

For each file, in your final reply, state ONE concrete invariant the file
enforces (one bullet per file, one line each). End with a single line
"audit-ok" if and only if you completed all five readings without skipping.

Do NOT modify any files. Do NOT call any tools other than file reads.
`.trim();

function buildContext(label) {
  const events = [];
  const plan = createDispatchPlan({
    taskId: `task-budget-eval-${label}`,
    instruction: RESEARCH_INSTRUCTION,
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: process.cwd(),
    },
    artifactLocation: 'results/task-artifacts',
    resources: {
      requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 600, gpuCards: 0 },
    },
  });
  return {
    events,
    context: {
      plan,
      instance: {
        taskId: plan.taskId,
        instanceId: `agent-${plan.taskId}-${Date.now()}`,
        createdAt: new Date().toISOString(),
        runtimeSettings: plan.runtimeSettings,
      },
      emit: async (event) => {
        events.push(event);
        if (event.kind === 'item.completed') {
          process.stderr.write(
            `[${label}/event] item.completed type=${event.item?.type} ` +
              `summary=${JSON.stringify((event.item?.summary ?? '').slice(0, 60))}\n`,
          );
        } else if (event.kind === 'turn.started' || event.kind === 'turn.completed') {
          process.stderr.write(`[${label}/event] ${event.kind}\n`);
        }
      },
      requestApproval: async ({ request }) => {
        process.stderr.write(
          `[${label}/approval] ${request.kind} ${request.toolName ?? ''}\n`,
        );
        // Approve so file reads can run.
        return { status: 'approved' };
      },
      isAborted: () => false,
    },
  };
}

function summarize(label, events, result, elapsedMs) {
  const kinds = {};
  let toolUseCount = 0;
  let finalText = '';
  let turns = 0;
  for (const e of events) {
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    if (e.kind === 'item.completed') {
      const t = e.item?.type;
      if (t === 'command_execution' || t === 'file_change' || t === 'mcp_tool_call' || t === 'web_search') {
        toolUseCount++;
      }
      if (t === 'agent_message') {
        const text = e.item?.summary ?? e.item?.text ?? '';
        if (typeof text === 'string' && text.length > finalText.length) {
          finalText = text;
        }
      }
    }
    if (e.kind === 'turn.completed') turns++;
  }
  const auditOk = /audit-ok/i.test(finalText);
  return {
    label,
    causeKind: result?.cause?.kind ?? 'driver-threw',
    provenance: result?.provenance,
    elapsedMs,
    eventCount: events.length,
    emitKinds: kinds,
    toolUseCount,
    turns,
    finalLength: finalText.length,
    finalPreview: finalText.slice(0, 200),
    auditOk,
  };
}

const runs = [];

async function runClaude(label, maxTurns) {
  const driver = new ClaudeAgentRuntimeDriver({
    queryFactory: createDefaultClaudeAgentQueryFactory(),
    pathToClaudeCodeExecutable: claudeCliPath,
    permissionMode: 'bypassPermissions',
    maxTurns,
  });
  const { events, context } = buildContext(label);
  const start = Date.now();
  let result;
  try {
    result = await driver.run(context);
  } catch (error) {
    process.stderr.write(`[${label}] DRIVER THREW: ${error?.name} ${error?.message}\n`);
    return summarize(label, events, undefined, Date.now() - start);
  }
  return summarize(label, events, result, Date.now() - start);
}

async function runCodex(label) {
  const codexResolution = resolveCodexBootstrapResolution(process.env);
  const driver = new CodexRuntimeDriver({
    codexOptions: codexResolution.options,
    codexRuntimeConfig: codexResolution.runtimeConfig,
  });
  const { events, context } = buildContext(label);
  const start = Date.now();
  let result;
  try {
    result = await driver.run(context);
  } catch (error) {
    process.stderr.write(`[${label}] DRIVER THREW: ${error?.name} ${error?.message}\n`);
    return summarize(label, events, undefined, Date.now() - start);
  }
  return summarize(label, events, result, Date.now() - start);
}

process.stderr.write('=== Run 1: Claude Agent, max_turns=2 (baseline tight) ===\n');
runs.push(await runClaude('claude-mt2', 2));

process.stderr.write('\n=== Run 2: Claude Agent, max_turns=15 (mid) ===\n');
runs.push(await runClaude('claude-mt15', 15));

process.stderr.write('\n=== Run 3: Claude Agent, max_turns=40 (long) ===\n');
runs.push(await runClaude('claude-mt40', 40));

process.stderr.write('\n=== Run 4: Codex (no max_turns concept; relies on natural completion) ===\n');
runs.push(await runCodex('codex-natural'));

console.log('\n--- turn-budget evaluation summary ---');
for (const r of runs) {
  console.log(JSON.stringify(r));
}

console.log('\n--- comparison ---');
console.log('label\t\tcause\t\tturns\tevents\ttool_use\taudit_ok\telapsedMs');
for (const r of runs) {
  console.log(
    `${r.label}\t${r.causeKind}\t${r.turns}\t${r.eventCount}\t${r.toolUseCount}\t\t${r.auditOk}\t\t${r.elapsedMs}`,
  );
}
